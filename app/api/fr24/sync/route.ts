import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FR24_KEY = process.env.FR24_API_KEY ?? ''
const SB_URL   = process.env.SUPABASE_URL!
const SB_KEY   = process.env.SUPABASE_ANON_KEY!

// Fetch IATA flight numbers from DB — FR24 /api/flight-summary/full queries by IATA number.
async function fetchIataNumbers(): Promise<string[]> {
  const res = await fetch(
    `${SB_URL}/rest/v1/rpc/get_syria_iata_numbers`,
    {
      method: 'POST',
      headers: {
        apikey:          SB_KEY,
        Authorization:   `Bearer ${SB_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!res.ok) throw new Error(`DB IATA numbers fetch failed: ${res.status}`)
  const rows: { iata_number: string }[] = await res.json()
  return rows.map(r => r.iata_number).filter(Boolean)
}

// FR24 returns YYYY-MM-DDTHH:MM:SS without Z — normalise to ISO 8601
function toISO(dt: string | null | undefined): string | null {
  if (!dt) return null
  return dt.endsWith('Z') ? dt : `${dt}Z`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveStatus(r: any): string {
  if (r.datetime_landed) return 'Landed'
  if (r.datetime_takeoff) return 'En Route'
  return 'Unknown'
}

export async function GET(req: Request) {
  try {
    const secret = process.env.CRON_SECRET
    if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    if (!FR24_KEY) return NextResponse.json({ ok: false, error: 'FR24_API_KEY not set' }, { status: 500 })

    const now = new Date()

    // 30-hour lookback catches overnight flights (departed yesterday, landed today)
    const from = new Date(now.getTime() - 30 * 3_600_000).toISOString().slice(0, 19)
    const to   = now.toISOString().slice(0, 19)

    // ── 1. Fetch IATA numbers from DB ────────────────────────────────────────
    const allIata = await fetchIataNumbers()
    if (allIata.length === 0) {
      return NextResponse.json({ ok: true, synced: 0, reason: 'no IATA numbers from DB' })
    }

    // ── 2. Fetch FR24 flight summaries in batches of 15 (API max) ────────────
    const BATCH = 15
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allResults: any[] = []

    for (let i = 0; i < allIata.length; i += BATCH) {
      const batch  = allIata.slice(i, i + BATCH)
      const params = new URLSearchParams({
        flights:              batch.join(','),
        flight_datetime_from: from,
        flight_datetime_to:   to,
      })
      try {
        const res = await fetch(`https://fr24api.flightradar24.com/api/flight-summary/full?${params}`, {
          headers: {
            Accept:           'application/json',
            'Accept-Version': 'v1',
            Authorization:    `Bearer ${FR24_KEY}`,
          },
          signal: AbortSignal.timeout(12_000),
        })
        if (!res.ok) continue
        const json = await res.json()
        const data = Array.isArray(json) ? json : (json.data ?? [])
        allResults.push(...data)
      } catch { /* skip bad batch, continue */ }
    }

    if (allResults.length === 0) {
      return NextResponse.json({ ok: true, synced: 0, reason: 'no FR24 results' })
    }

    // ── 3. Load existing rows that already have AeroDataBox actuals ──────────
    const today     = now.toISOString().slice(0, 10)
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)

    const existingRes = await fetch(
      `${SB_URL}/rest/v1/flight_status?operating_date=gte.${yesterday}&select=callsign,operating_date,actual_dep_utc,actual_arr_utc`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingRows: any[] = existingRes.ok ? await existingRes.json() : []

    const hasActualDep = new Set(existingRows.filter(r => r.actual_dep_utc).map(r => r.callsign))
    const hasActualArr = new Set(existingRows.filter(r => r.actual_arr_utc).map(r => r.callsign))

    // ── 4. Build upsert rows — only fill nulls, never overwrite ADB data ─────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = allResults
      .filter(r => r.callsign && (r.datetime_takeoff || r.datetime_landed))
      .map(r => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row: Record<string, any> = {
          callsign:       r.callsign,
          operating_date: (r.datetime_takeoff ?? r.first_seen ?? today).slice(0, 10),
          flight_number:  r.flight    ?? null,
          dep_iata:       r.orig_iata ?? null,
          arr_iata:       r.dest_iata_actual ?? r.dest_iata ?? null,
          dep_icao:       r.orig_icao ?? null,
          arr_icao:       r.dest_icao_actual ?? r.dest_icao ?? null,
          aircraft_type:  r.type      ?? null,
          status:         deriveStatus(r),
          last_synced_at: now.toISOString(),
        }
        if (!hasActualDep.has(r.callsign)) row.actual_dep_utc = toISO(r.datetime_takeoff)
        if (!hasActualArr.has(r.callsign)) row.actual_arr_utc = toISO(r.datetime_landed)

        if (row.actual_dep_utc === undefined && row.actual_arr_utc === undefined) return null
        return row
      })
      .filter(Boolean)

    if (rows.length === 0) {
      return NextResponse.json({
        ok: true, synced: 0,
        reason: 'all actuals already confirmed by AeroDataBox',
        fr24_results: allResults.length,
      })
    }

    // ── 5. Upsert ─────────────────────────────────────────────────────────────
    const sbRes = await fetch(`${SB_URL}/rest/v1/flight_status`, {
      method: 'POST',
      headers: {
        apikey:          SB_KEY,
        Authorization:   `Bearer ${SB_KEY}`,
        'Content-Type':  'application/json',
        Prefer:          'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    })

    if (!sbRes.ok) {
      return NextResponse.json({ ok: false, error: await sbRes.text() }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      synced:       rows.length,
      fr24_results: allResults.length,
      skipped_adb:  allResults.length - rows.length,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

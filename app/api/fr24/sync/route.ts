import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FR24_KEY = process.env.FR24_API_KEY ?? ''
const SB_URL   = process.env.SUPABASE_URL!
const SB_KEY   = process.env.SUPABASE_ANON_KEY!

// Same IATA flight numbers as AeroDataBox subscribe route.
const ALL_FLIGHTS = [
  // Air Arabia (G9)
  'G9351','G9352','G9363','G9364','G9375','G9376','G9433','G9434',
  // Etihad (EY)
  'EY561','EY562',
  // Flynas (F3)
  'F3561','F3562','F3741','F3742',
  // flydubai (FZ)
  'FZ1113','FZ1114','FZ1115','FZ1116','FZ1847','FZ1848',
  // FlyOne Armenia (XH)
  'XH361','XH362','XH455','XH456',
  'XH485','XH486','XH489','XH490','XH491','XH492',
  'XH501','XH502','XH521','XH522','XH523','XH524','XH525','XH526',
  'XH701','XH702','XH725','XH726','XH727','XH728',
  'XH731','XH732','XH741','XH742','XH743','XH744',
  'XH761','XH762','XH781','XH782','XH831','XH832',
  // Jubba Airways (DN)
  'DN541','DN542','DN551','DN552',
  // Jazeera Airways (J9)
  'J9171','J9172','J9173','J9174','J9175','J9176','J9177','J9178','J9181','J9182',
  // Kuwait Airways (KU)
  'KU551','KU552',
  // Nesma Airlines (XY)
  'XY377','XY378','XY387','XY388','XY591','XY592','XY892','XY893',
  // Pegasus (PC)
  'PC770','PC771',
  // Qatar Airways (QR)
  'QR410','QR411',
  // Royal Jordanian (RJ)
  'RJ237','RJ431','RJ432','RJ433','RJ434','RJ435','RJ436','RJ437','RJ438',
  // Syrian Air (RB)
  'RB271','RB272','RB341','RB342',
  'RB381','RB382','RB389','RB390',
  'RB443','RB444','RB445','RB446',
  'RB501','RB502','RB503','RB504','RB515','RB516','RB521','RB522',
  // Turkish Airlines (TK)
  'TK840','TK841','TK844','TK845','TK846','TK847','TK848','TK849',
  // Tailwind / VF
  'VF317','VF318','VF340','VF341','VF591','VF592',
]

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

    // ── 1. Fetch FR24 flight summaries in batches of 15 (API max) ────────────
    const BATCH = 15
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allResults: any[] = []

    for (let i = 0; i < ALL_FLIGHTS.length; i += BATCH) {
      const batch  = ALL_FLIGHTS.slice(i, i + BATCH)
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

    // ── 2. Load existing rows that already have AeroDataBox actuals ──────────
    // We do NOT overwrite AeroDataBox-confirmed timestamps with FR24 estimates.
    const today = now.toISOString().slice(0, 10)
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)

    const existingRes = await fetch(
      `${SB_URL}/rest/v1/flight_status?operating_date=gte.${yesterday}&select=callsign,operating_date,actual_dep_utc,actual_arr_utc`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingRows: any[] = existingRes.ok ? await existingRes.json() : []

    const hasActualDep = new Set(existingRows.filter(r => r.actual_dep_utc).map(r => r.callsign))
    const hasActualArr = new Set(existingRows.filter(r => r.actual_arr_utc).map(r => r.callsign))

    // ── 3. Build upsert rows — only fill nulls, never overwrite ADB data ─────
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
        // Only include actual timestamps if AeroDataBox hasn't confirmed them yet
        if (!hasActualDep.has(r.callsign)) row.actual_dep_utc = toISO(r.datetime_takeoff)
        if (!hasActualArr.has(r.callsign)) row.actual_arr_utc = toISO(r.datetime_landed)

        // Skip rows where we have nothing new to offer
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

    // ── 4. Upsert — merge-duplicates leaves columns absent from body unchanged ─
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
      const err = await sbRes.text()
      return NextResponse.json({ ok: false, error: err }, { status: 500 })
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

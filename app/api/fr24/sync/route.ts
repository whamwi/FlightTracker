import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FR24_KEY = process.env.FR24_API_KEY ?? ''
const SB_URL   = process.env.SUPABASE_URL!
const SB_KEY   = process.env.SUPABASE_ANON_KEY!

// Fetch flight identifiers for FR24 flight-summary lookup.
// All flights use the flights= param (IATA flight number) — the callsigns= param
// returns no results from the flight-summary API even when FR24 tracks the callsign live.
// Flights with no IATA number fall back to callsigns= as a last resort.
// Returns iataToCallsign map so FR24 results can be re-keyed to broadcast callsign.
async function fetchFr24Identifiers(): Promise<{
  iataFlights: string[]
  callsigns: string[]
  iataToCallsign: Record<string, string>
  iataToFr24Id: Record<string, string>
}> {
  const res = await fetch(
    `${SB_URL}/rest/v1/rpc/get_syria_flight_pairs`,
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
  if (!res.ok) throw new Error(`DB flight pairs fetch failed: ${res.status}`)
  const rows: { iata_number: string; broadcast_callsign: string; fr24_id: string | null }[] = await res.json()
  const iataFlights:    string[] = []
  const callsigns:      string[] = []
  const iataToCallsign: Record<string, string> = {}
  const iataToFr24Id:   Record<string, string> = {}
  for (const r of rows) {
    if (r.iata_number) {
      if (r.iata_number.startsWith('XH') && r.broadcast_callsign) {
        // Cham Wings: FR24 tracks these by broadcast callsign (FYC486), not by IATA (XH486).
        // The flights= param is for IATA numbers; callsigns= is the correct param here.
        callsigns.push(r.broadcast_callsign)
        // Keep IATA → callsign mapping so result rows (which carry r.flight=XH486) can be
        // re-keyed to the broadcast callsign when FR24 omits the callsign field.
        iataToCallsign[r.iata_number.toUpperCase()] = r.broadcast_callsign
        if (r.fr24_id) iataToFr24Id[r.broadcast_callsign.toUpperCase()] = r.fr24_id
      } else {
        iataFlights.push(r.iata_number)
        if (r.broadcast_callsign) iataToCallsign[r.iata_number.toUpperCase()] = r.broadcast_callsign
        if (r.fr24_id) iataToFr24Id[r.iata_number.toUpperCase()] = r.fr24_id
      }
    } else if (r.broadcast_callsign) {
      callsigns.push(r.broadcast_callsign)
    }
  }
  return { iataFlights, callsigns, iataToCallsign, iataToFr24Id }
}

// Write newly discovered FR24 IDs back to flight_lookup so future syncs can use them.
async function backfillFr24Ids(discovered: Record<string, string>): Promise<void> {
  const entries = Object.entries(discovered)
  if (entries.length === 0) return
  await Promise.all(entries.map(([iata, fr24Id]) =>
    fetch(
      `${SB_URL}/rest/v1/flight_lookup?iata_number=eq.${encodeURIComponent(iata)}`,
      {
        method: 'PATCH',
        headers: {
          apikey:         SB_KEY,
          Authorization:  `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json',
          Prefer:         'return=minimal',
        },
        body: JSON.stringify({ fr24_id: fr24Id }),
      },
    )
  ))
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

    // 30-hour lookback for flights without a stored fr24_id
    const from = new Date(now.getTime() - 30 * 3_600_000).toISOString().slice(0, 19)
    const to   = now.toISOString().slice(0, 19)

    // ── 1. Fetch FR24 identifiers from DB ────────────────────────────────────
    const { iataFlights, callsigns: fycCallsigns, iataToCallsign, iataToFr24Id } = await fetchFr24Identifiers()
    if (iataFlights.length === 0 && fycCallsigns.length === 0) {
      return NextResponse.json({ ok: true, synced: 0, reason: 'no identifiers from DB' })
    }

    // ── 2. Load today's stored fr24_ids from flight_status ───────────────────
    // For flights we already know the fr24_id for, call flight-summary/full?flight_ids=
    // directly — no time window needed, returns the exact flight instance.
    const today     = now.toISOString().slice(0, 10)
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)

    const knownIdRes = await fetch(
      `${SB_URL}/rest/v1/flight_status?operating_date=gte.${yesterday}&fr24_id=not.is.null&select=callsign,fr24_id,operating_date`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const knownIdRows: any[] = knownIdRes.ok ? await knownIdRes.json() : []
    const knownFr24Ids    = knownIdRows.map(r => r.fr24_id as string)
    const fr24IdToCallsign: Record<string, string> = {}
    for (const r of knownIdRows) fr24IdToCallsign[r.fr24_id] = r.callsign

    // ── 3. Fetch FR24 flight summaries ───────────────────────────────────────
    const BATCH = 15
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allResults: any[] = []

    // 3a. Known fr24_ids → flight-summary/full?flight_ids= (most accurate, no time window)
    for (let i = 0; i < knownFr24Ids.length; i += BATCH) {
      const batch = knownFr24Ids.slice(i, i + BATCH)
      try {
        const res = await fetch(
          `https://fr24api.flightradar24.com/api/flight-summary/full?flight_ids=${batch.join(',')}`,
          {
            headers: { Accept: 'application/json', 'Accept-Version': 'v1', Authorization: `Bearer ${FR24_KEY}` },
            signal: AbortSignal.timeout(12_000),
          },
        )
        if (!res.ok) continue
        const json = await res.json()
        const data: any[] = Array.isArray(json) ? json : (json.data ?? [])
        // Attach callsign from our map so downstream code can key by it
        for (const r of data) {
          if (!r.callsign && r.fr24_id) r.callsign = fr24IdToCallsign[r.fr24_id] ?? r.callsign
        }
        allResults.push(...data)
      } catch { /* skip bad batch */ }
    }

    // 3b. Flights without a stored fr24_id → search by flight number + time window
    const knownCallsigns = new Set(knownIdRows.map(r => r.callsign as string))
    const newIataFlights = iataFlights.filter(id => {
      const cs = iataToCallsign[id.toUpperCase()]
      return !cs || !knownCallsigns.has(cs)
    })
    const newCallsigns = fycCallsigns.filter(cs => !knownCallsigns.has(cs))

    const fetchBatches = async (ids: string[], paramKey: 'flights' | 'callsigns') => {
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch  = ids.slice(i, i + BATCH)
        const params = new URLSearchParams({
          [paramKey]:           batch.join(','),
          flight_datetime_from: from,
          flight_datetime_to:   to,
        })
        try {
          const res = await fetch(`https://fr24api.flightradar24.com/api/flight-summary/full?${params}`, {
            headers: { Accept: 'application/json', 'Accept-Version': 'v1', Authorization: `Bearer ${FR24_KEY}` },
            signal: AbortSignal.timeout(12_000),
          })
          if (!res.ok) continue
          const json = await res.json()
          const data = Array.isArray(json) ? json : (json.data ?? [])
          allResults.push(...data)
        } catch { /* skip bad batch, continue */ }
      }
    }

    await fetchBatches(newIataFlights, 'flights')
    await fetchBatches(newCallsigns, 'callsigns')

    if (allResults.length === 0) {
      return NextResponse.json({ ok: true, synced: 0, reason: 'no FR24 results' })
    }

    // ── 4. Load existing rows that already have AeroDataBox actuals ──────────
    const existingRes = await fetch(
      `${SB_URL}/rest/v1/flight_status?operating_date=gte.${yesterday}&select=callsign,operating_date,actual_dep_utc,actual_arr_utc`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingRows: any[] = existingRes.ok ? await existingRes.json() : []

    const hasActualDep = new Set(existingRows.filter(r => r.actual_dep_utc).map(r => `${r.callsign}|${r.operating_date}`))
    const hasActualArr = new Set(existingRows.filter(r => r.actual_arr_utc).map(r => `${r.callsign}|${r.operating_date}`))

    // ── 5. Build upsert rows — only fill nulls, never overwrite ADB data ─────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = allResults
      .filter(r => (r.callsign || r.flight) && (r.datetime_takeoff || r.datetime_landed))
      .map(r => {
        // FR24 may omit callsign when queried by IATA number — resolve from our map.
        const callsign: string = r.callsign ?? iataToCallsign[(r.flight ?? '').toUpperCase()] ?? r.flight
        if (!callsign) return null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row: Record<string, any> = {
          callsign,
          // When FR24 only has the landing (midnight crossers caught at arrival),
          // back-calculate the departure date using landed - 6h rather than first_seen,
          // which would otherwise stamp the arrival date as the operating_date.
          operating_date: r.datetime_takeoff
            ? r.datetime_takeoff.slice(0, 10)
            : r.datetime_landed
              ? new Date(new Date((r.datetime_landed as string).endsWith('Z') ? r.datetime_landed : r.datetime_landed + 'Z').getTime() - 6 * 3_600_000).toISOString().slice(0, 10)
              : today,
          flight_number:  r.flight    ?? null,
          dep_iata:       r.orig_iata ?? null,
          arr_iata:       r.dest_iata_actual ?? r.dest_iata ?? null,
          dep_icao:       r.orig_icao ?? null,
          arr_icao:       r.dest_icao_actual ?? r.dest_icao ?? null,
          aircraft_type:  r.type      ?? null,
          status:         deriveStatus(r),
          fr24_id:        r.fr24_id ?? r.id ?? null,
          last_synced_at: now.toISOString(),
        }
        const dateKey = `${callsign}|${row.operating_date}`
        if (!hasActualDep.has(dateKey)) row.actual_dep_utc = toISO(r.datetime_takeoff)
        if (!hasActualArr.has(dateKey)) row.actual_arr_utc = toISO(r.datetime_landed)

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

    // ── 6. Deduplicate by (callsign, operating_date) ──────────────────────────
    // FR24 may return multiple legs for the same flight number on the same day.
    // Postgres merge-duplicates rejects a batch with two rows targeting the same PK.
    // Keep the row with the most complete data (prefer actual_arr_utc > actual_dep_utc > neither).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deduped = new Map<string, Record<string, any>>()
    for (const row of rows as Record<string, any>[]) {
      const key = `${row.callsign}|${row.operating_date}`
      const existing_ = deduped.get(key)
      if (!existing_) {
        deduped.set(key, row)
      } else {
        // Prefer whichever row has more actuals set
        const newScore = (row.actual_arr_utc ? 4 : 0) + (row.actual_dep_utc ? 2 : 0) + (row.fr24_id ? 1 : 0)
        const oldScore = (existing_.actual_arr_utc ? 4 : 0) + (existing_.actual_dep_utc ? 2 : 0) + (existing_.fr24_id ? 1 : 0)
        if (newScore > oldScore) deduped.set(key, row)
      }
    }
    const dedupedRows = [...deduped.values()]

    // ── 7. Upsert — split by present fields to satisfy PGRST102 ─────────────
    // PostgREST requires all rows in a batch to have identical key sets.
    // Rows conditionally include actual_dep_utc / actual_arr_utc (to avoid
    // overwriting ADB-confirmed values), so we split into up to 3 batches.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batches: Record<string, any[]> = { both: [], dep_only: [], arr_only: [] }
    for (const r of dedupedRows as Record<string, unknown>[]) {
      const hasDep = 'actual_dep_utc' in r
      const hasArr = 'actual_arr_utc' in r
      if (hasDep && hasArr) batches.both.push(r)
      else if (hasDep)      batches.dep_only.push(r)
      else                  batches.arr_only.push(r)
    }

    let upsertErrors: string[] = []
    for (const batch of Object.values(batches)) {
      if (batch.length === 0) continue
      const sbRes = await fetch(`${SB_URL}/rest/v1/flight_status`, {
        method: 'POST',
        headers: {
          apikey:          SB_KEY,
          Authorization:   `Bearer ${SB_KEY}`,
          'Content-Type':  'application/json',
          Prefer:          'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(batch),
      })
      if (!sbRes.ok) upsertErrors.push(await sbRes.text())
    }

    if (upsertErrors.length > 0) {
      return NextResponse.json({ ok: false, error: upsertErrors }, { status: 500 })
    }

    // ── 8. Back-fill flight_lookup.fr24_id for newly discovered IDs ──────────
    // Collect the first FR24 occurrence ID seen per IATA number this sync run.
    // Only write for flights that didn't already have an fr24_id in the DB.
    const newFr24Ids: Record<string, string> = {}
    for (const r of allResults) {
      const rid = r.fr24_id ?? r.id
      if (!rid || !r.flight) continue
      const iata = (r.flight as string).toUpperCase()
      if (!iataToFr24Id[iata] && !newFr24Ids[iata]) {
        newFr24Ids[iata] = rid
      }
    }
    await backfillFr24Ids(newFr24Ids)

    return NextResponse.json({
      ok: true,
      synced:       dedupedRows.length,
      fr24_results: allResults.length,
      duplicates_dropped: rows.length - dedupedRows.length,
      skipped_adb:  allResults.length - rows.length,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

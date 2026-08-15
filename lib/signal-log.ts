/**
 * Position history and flight milestones, written from wherever the positions come from.
 *
 * This was the body of /api/signal-log, called only by a visitor's browser. That made two
 * production paths depend on somebody watching: cron/carry-over reads flight_signal_log.airborne_at
 * to notice a carried-over flight that is actually flying — the FYC781 case — and /api/airspace
 * reads flight_position_log for fixes that are often the only ones a flight has.
 *
 * Measured 15 Aug 2026 before moving it: five consecutive hours, 20:00–00:00 UTC, with not one row
 * written. Not a quiet sky — nobody had the map open. And every row carried a dep_iata, which only
 * the board-matched browser path supplies, so the gaps and the shape both point the same way.
 *
 * A comment in /api/airspace asserted that cron/opensky-poll was writing these rows worldwide. It
 * is not in vercel.json and never has been; the data shows no trace of it.
 *
 * Batched deliberately. The original did three round-trips per aircraft — read the summary, insert
 * the position, upsert the summary — which is fine for one browser reporting a handful of flights
 * and is not fine for a cron sweeping the whole region every minute. Three requests total now,
 * whatever the count.
 */

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

export interface SignalReading {
  callsign:     string
  flight_date:  string
  lat:          number
  lon:          number
  alt_baro:     number | null
  gs:           number | null
  track:        number | null
  hex:          string | null
  dep_iata:     string | null
  arr_iata:     string | null
  iata_number?: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

/** The operating date a fix belongs to. Syria files its day against UTC+3. */
export function syriaOpDate(nowMs: number): string {
  return new Date(nowMs + 3 * 3_600_000).toISOString().slice(0, 10)
}

/**
 * Record a batch of readings: one position row each, and one merged milestone row per flight.
 *
 * Milestones are never overwritten once set — the first time we see it moving is its departure,
 * and a later fix showing it moving again must not restamp that. Returns the number of readings
 * accepted so a caller can log something meaningful rather than assuming success.
 */
export async function logSignals(batch: SignalReading[], nowIso: string): Promise<number> {
  const valid = batch.filter(r => r.callsign && r.flight_date && r.lat != null && r.lon != null)
  if (valid.length === 0) return 0

  /*
   * One read for the whole batch. PostgREST has no tuple-IN, so this asks for every callsign in
   * the batch across the dates present and filters the pairs back out in memory — with a handful
   * of dates in play that is a far smaller matrix than it sounds, and one request either way.
   */
  const callsigns = [...new Set(valid.map(r => r.callsign))]
  const dates     = [...new Set(valid.map(r => r.flight_date))]
  const existing  = new Map<string, Row>()
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/flight_signal_log`
      + `?callsign=in.(${callsigns.map(encodeURIComponent).join(',')})`
      + `&flight_date=in.(${dates.join(',')})&select=*`,
      { headers: HEADERS },
    )
    if (res.ok) for (const row of (await res.json()) as Row[]) {
      existing.set(`${row.callsign}|${row.flight_date}`, row)
    }
  } catch { /* An unreadable summary means milestones get re-derived, not lost. */ }

  const positions: Row[] = []
  const summaries = new Map<string, Row>()

  for (const r of valid) {
    const key = `${r.callsign}|${r.flight_date}`
    const ex  = existing.get(key)
    const alt = r.alt_baro ?? 0
    const gs  = r.gs       ?? 0

    positions.push({
      callsign: r.callsign, flight_date: r.flight_date, captured_at: nowIso,
      lat: r.lat, lon: r.lon,
      alt_baro: r.alt_baro, gs: r.gs, track: r.track, hex: r.hex,
      dep_iata: r.dep_iata, arr_iata: r.arr_iata,
    })

    // A batch can carry two fixes for one flight; the later one must see the earlier one's work.
    const prior = summaries.get(key) ?? ex
    const airborne_at   = prior?.airborne_at   ?? (alt > 500 ? nowIso : null)
    const actual_dep_at = prior?.actual_dep_at ?? (gs >= 50  ? nowIso : null)
    const actual_arr_at = prior?.actual_arr_at ?? (
      (prior?.airborne_at || airborne_at) && gs < 30 && alt < 100 ? nowIso : null
    )

    summaries.set(key, {
      callsign:      r.callsign,
      flight_date:   r.flight_date,
      hex:           r.hex      ?? prior?.hex      ?? null,
      dep_iata:      r.dep_iata ?? prior?.dep_iata ?? null,
      arr_iata:      r.arr_iata ?? prior?.arr_iata ?? null,
      first_seen_at: ex?.first_seen_at ?? nowIso,
      last_seen_at:  nowIso,
      actual_dep_at, airborne_at, actual_arr_at,
    })
  }

  /*
   * Checked, not fire-and-forget — the same rule airspace-poll states for its own write, and for
   * the same reason. The first version of this used Promise.allSettled and wrote nothing at all
   * for six minutes after deploy while every surface looked healthy: the cron logged four sweeps
   * a minute, aircraft_last_seen filled normally, and the only evidence of failure was a table
   * that stayed empty. A swallowed error here is indistinguishable from an empty sky.
   */
  const errors: string[] = []
  const send = async (table: string, rows: Row[], resolution: string) => {
    if (rows.length === 0) return
    try {
      const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
        method:  'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: `resolution=${resolution},return=minimal` },
        body:    JSON.stringify(rows),
      })
      if (!res.ok) errors.push(`${table} ${res.status}: ${(await res.text()).slice(0, 160)}`)
    } catch (e) {
      errors.push(`${table} threw: ${String(e).slice(0, 160)}`)
    }
  }

  await Promise.all([
    send('flight_position_log', positions, 'ignore-duplicates'),
    send('flight_signal_log', [...summaries.values()], 'merge-duplicates'),
  ])

  if (errors.length) throw new Error(errors.join(' | '))
  return valid.length
}

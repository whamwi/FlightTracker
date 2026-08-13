/**
 * The board from `flight`, shared by every surface that needs one.
 *
 * As of 13 Aug 2026 this replaces `fr24_daily_cache` — a table warmed by whichever visitor
 * happened to open the site — with `flight`, maintained by the harvester on a schedule.
 * Compared field by field on 13 Aug across 95 flights, identical set, no flight in one and
 * missing from the other:
 *
 *   actual_arr_utc    22 flights the cache did not know had landed
 *   revised_arr_utc   27 still carrying an estimate for a flight already down
 *   duration_min      28 following from those two
 *   aircraft_reg      10 blank in the cache
 *   status             5 e.g. 3L505 Departed in the cache, Arrived in v2
 *   airline_iata       4 e.g. 3L456 called G9 — a different airline, wrong name and logo
 *   arr_baggage        9 shown by the cache before the flight had arrived, which is the wrong
 *                        carousel: FR24 republishes belts from earlier instances of a number
 *
 * It lives here rather than in the board route because /api/flight needs the same document.
 * Two copies of this fetch would let the detail page and the board disagree about one flight —
 * which is the class of bug the whole migration exists to remove.
 */
const V2_API = process.env.FLIGHT_API_URL ?? 'https://flight-api-production-5124.up.railway.app'

export type BoardFlightV2 = {
  iata_number: string
  callsign: string | null
  airline_name: string
  airline_iata: string
  country_flag: string
  dep_iata: string
  arr_iata: string
  dep_time_utc: string
  arr_time_utc: string
  sched_dep_unix: number | null
  duration_min: number
  status: string
  actual_dep_utc: string | null
  actual_arr_utc: string | null
  arr_confirmed: boolean
  arr_confirmed_src: string | null
  revised_dep_utc: string | null
  revised_arr_utc: string | null
  aircraft_type: string | null
  aircraft_reg: string | null
  dep_terminal: string | null
  dep_gate: string | null
  arr_terminal: string | null
  arr_gate: string | null
  arr_baggage: string | null
  arr_next_day: boolean
  dep_prev_day: boolean
  dep_confirmed: boolean
}

/**
 * One day's board, or null if the service cannot answer.
 *
 * Null rather than throwing, because callers fall back to the cache. That fallback is deliberate
 * on the board and deliberately absent in the alert path: a stale board is visibly wrong and
 * corrects itself on the next refresh, while a stale alert is silent and unrecoverable.
 *
 * `label` only names the caller in the log line, so a fallback can be traced to the surface that
 * took it. It is scaffolding — once these have run without falling back, the cache paths go.
 */
export async function boardFromV2(date: string, label: string): Promise<BoardFlightV2[] | null> {
  try {
    const res = await fetch(`${V2_API}/v2/board?date=${date}`, { cache: 'no-store' })
    if (!res.ok) {
      console.warn(`[${label}] v2 answered ${res.status} for ${date} — falling back to cache`)
      return null
    }
    const body = await res.json()
    const flights = body?.flights
    if (!Array.isArray(flights) || flights.length === 0) {
      // An empty board is indistinguishable from a broken one at this layer, and a day with no
      // flights does not happen here. Treat it as a failure rather than publishing a blank page.
      console.warn(`[${label}] v2 returned ${flights?.length ?? 'no'} flights for ${date} — falling back`)
      return null
    }
    return flights as BoardFlightV2[]
  } catch (e) {
    console.warn(`[${label}] v2 unreachable for ${date}: ${e} — falling back to cache`)
    return null
  }
}

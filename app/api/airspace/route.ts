import { NextResponse, after } from 'next/server'
import { sweepAllCircles } from '@/lib/adsb-feed'
import { fetchIataToIcao, fetchCallsignLookup, resolveCallsign, type CallsignLookup } from '@/lib/callsign'
import { SYRIA_AIRPORT_SET } from '@/lib/syria-airports'
import { rankInstance } from '@/lib/flight-status'
import { inSyria } from '@/lib/syria-airspace'

export const dynamic = 'force-dynamic'

/**
 * How far outside its own window a flight may still be, and still be the flight we are looking at.
 *
 * Two hours, or one block time for the long ones. Wide on purpose: this rejects identities, so it
 * has to clear a badly delayed flight without hesitating.
 */
const AIRBORNE_SLACK_MS = 2 * 3_600_000

/**
 * Could this board row describe an aircraft that is in the air right now?
 *
 * On 14 Aug JY-RAN left Amman at 13:26 operating RJ437 to Damascus, and for the first two minutes
 * its transponder sent RJA435 — the morning AMM–DAM service, which had landed at 04:16. We matched
 * the fix to that row and drew a flight whose card counted down 14 hours to an arrival nine hours
 * in the past. It cleared itself when the callsign corrected, but two minutes of a phantom is two
 * minutes of the map being wrong, and a wrong flight ID is a common enough thing in a cockpit that
 * this will happen again.
 *
 * The tell needed no cleverness: a 55-minute hop cannot be fourteen hours from landing. So the
 * window is anchored on what the flight actually did — its real departure where we have one, its
 * real or revised arrival, else the block from departure — and a fix arriving outside that window
 * is not this flight. The identity is dropped rather than the position: with no board match the
 * client draws nothing, which is the right answer while the aircraft is lying about who it is.
 *
 * Returns true when there is nothing to judge against. This rejects data; it must not reject on
 * ignorance.
 */
function couldBeAirborne(f: BoardFlight, nowMs: number): boolean {
  const depMs = f.actual_dep_utc ? Date.parse(f.actual_dep_utc)
              : f.sched_dep      ? f.sched_dep * 1000
              : NaN
  if (!Number.isFinite(depMs)) return true

  const blockMs = (f.duration_min ?? 0) * 60_000
  const arrMs = f.actual_arr_utc  ? Date.parse(f.actual_arr_utc)
              : f.revised_arr_utc ? Date.parse(f.revised_arr_utc)
              : blockMs           ? depMs + blockMs
              : f.sched_arr       ? f.sched_arr * 1000
              : NaN

  const slack = Math.max(AIRBORNE_SLACK_MS, blockMs)
  if (nowMs < depMs - slack) return false
  if (Number.isFinite(arrMs) && nowMs > arrMs + slack) return false
  return true
}

/**
 * How long an arrived flight stays drawn. Same meaning as ARRIVED_HOLD_MS in components/Map.tsx,
 * which governs it for aircraft we still hold a live fix for — they were four hours and thirty
 * minutes respectively, so a flight left the map at a different moment depending on which path
 * happened to draw it.
 */
const ARRIVED_HOLD_MS = 30 * 60_000

const SB_URL     = process.env.SUPABASE_URL!
const SB_KEY     = process.env.SUPABASE_ANON_KEY!
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

// ── Visual radius feeds ───────────────────────────────────────────────────────
// `dist` is in NAUTICAL MILES, not km — verified against a dense-coverage area, where a
// dist=250 query returned aircraft out to 233 nm (431 km). So the Syria circle spans
// 1,296 km, not 700. Get this wrong and the circles look half the size they are.
//
// Syria + neighbors: covers DAM, ALP, TK routes, LB, JO, IQ border traffic.
// UAE + Gulf: covers DXB, AUH, SHJ, DOH, BAH, KWI, MCT.
// adsb.fi's v2 lat/lon/dist endpoint is DEPRECATED and answers 200 with an empty `ac`
// array — not an error. Combined with the adsb.lol fallback also returning 200-and-empty
// for this region, that read as "feeds healthy, quiet sky" for as long as it was wrong.
// Measured 2026-08-02: v2 IST/250 → 0 aircraft, v3 IST/250 → 88, v3 DAM/250 → 31.
//
// v3 caps `dist` at 250 NM (400 returns HTTP 400) and the public rate limit is 1 req/s,
// so the circles are queried sequentially with a gap — see fetchAllFeeds. The old 700 and
// 400 NM radii were over the cap and could never have succeeded on v3.
// Syria's extent (32.31–37.32 N, 35.61–42.38 E) padded a little. Used only to drop
// non-board aircraft from the response — the client applies the exact polygon, so this
// deliberately errs wide.
// Deir ez-Zor opened to scheduled traffic on 5 Aug 2026. It has to be here for a DEZ flight
// to be recognised as Syrian at all: this set decides which end of a leg is "ours", and so
// which counterpart airport gets its board read for the arrival.
const SYRIA_AIRPORTS = SYRIA_AIRPORT_SET



function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// ── Airport coordinates (1h cache) ────────────────────────────────────────────
let apCoordCache: { map: Record<string, [number, number]>; ts: number } | null = null

async function fetchAirportCoords(): Promise<Record<string, [number, number]>> {
  if (apCoordCache && Date.now() - apCoordCache.ts < 3_600_000) return apCoordCache.map
  const res = await fetch(`${SB_URL}/rest/v1/airports?select=iata,lat,lon`, { headers: SB_HEADERS })
  if (!res.ok) return apCoordCache?.map ?? {}
  const rows: { iata: string; lat: number | null; lon: number | null }[] = await res.json()
  const map: Record<string, [number, number]> = {}
  for (const r of rows) {
    if (r.iata && typeof r.lat === 'number' && typeof r.lon === 'number') {
      map[r.iata.toUpperCase()] = [r.lat, r.lon]
    }
  }
  apCoordCache = { map, ts: Date.now() }
  return map
}

// ── IATA → ICAO airline prefix (1h cache) ─────────────────────────────────────

// Extract actual dep/arr UTC from FR24 status string ("Departed 01:55" → ISO).
// Times in status are Syria local (UTC+3); date is the Syria operating date.
function extractStatusUtc(status: string, keywords: string[], date: string): string | null {
  const t = status.toLowerCase()
  if (!keywords.some(kw => t.includes(kw))) return null
  const match = status.match(/\b(\d{1,2}):(\d{2})\b/)
  if (!match) return null
  const baseMs = new Date(date + 'T00:00:00Z').getTime()
  return new Date(baseMs + (parseInt(match[1]) * 60 + parseInt(match[2]) - 180) * 60_000).toISOString()
}
function extractActualDepUtc(status: string, date: string): string | null {
  return extractStatusUtc(status, ['departed', 'took off'], date)
}
function extractActualArrUtc(status: string, date: string): string | null {
  return extractStatusUtc(status, ['landed', 'arrived'], date)
}
function extractRevisedArrUtc(status: string, date: string): string | null {
  return extractStatusUtc(status, ['estimated', 'expect', 'delayed'], date)
}

// ── Board flights (from v2, Syria op date = UTC+3, 60s cache) ─────────────────
interface BoardFlight {
  num:            string        // raw FR24 value, as the board publishes it
  /**
   * The cache date this flight was read from — yesterday, today or tomorrow.
   *
   * The board is assembled from three dates and this was being discarded, so the departure
   * writebacks had nothing to go on and assumed today. That is right for a flight that departs
   * on its own date and wrong for the case that matters: FYC781 left at 04:15 on the 7th
   * against a schedule on the 6th, so the write went looking for it in a list that does not
   * contain it, matched nothing, and wrote the list back unchanged. Silently.
   */
  flight_date:    string
  iata_num:       string        // the ticketed IATA number (XH727), resolved via flight_lookup
  callsign:       string        // ADS-B broadcast callsign derived from num
  dep_iata:       string | null
  arr_iata:       string | null
  sched_dep:      number | null // unix
  sched_arr:      number | null // unix
  duration_min:   number | null
  status:         string        // raw FR24 status, lowercased
  actual_dep_utc:  string | null // from "Departed HH:MM" status
  actual_arr_utc:  string | null // from real_arr (landing-confirm cron) or "Landed HH:MM" status
  revised_arr_utc: string | null // FR24 est_arr or "Estimated HH:MM" status
  eta_stable_utc: string | null  // the same estimate, damped once by flight-api
  dep_delay_min:   number | null // actual_dep_utc − sched_dep
  airline_iata:    string | null // IATA code for airline logo
  /**
   * Registration and type, from the board rather than from whichever feed supplied the fix.
   *
   * The position sources disagree about these: the raw ADS-B feed carries both, /v2/live carries
   * neither. So the same aircraft had a photo while our receivers could hear it and lost it the
   * moment FR24 took over — ETD562 did exactly that on 13 Aug, and FYC728, SYR382 and RB382 never
   * had one at all. The board knows the registration for every flight it lists, which is why the
   * app has a photo for all of them: it reads /v2/board and joins this itself.
   *
   * Identity belongs to the board; the fix only says where the aircraft is.
   */
  reg:             string | null
  aircraft_type:   string | null
}

const V2_API = process.env.FLIGHT_API_URL ?? 'https://flight-api-production-5124.up.railway.app'

/**
 * Live positions from the one canonical table, for flights our own receivers cannot hear.
 *
 * The circles below are direct reception and stay the primary source: they are 2-4 seconds old,
 * while `fr24_live_position` is written on the harvester's 60-second sweep, so for an aircraft we
 * can hear ourselves the sweep is simply fresher. This fills the gap instead — FR24's feed covers
 * flights outside our coverage, and without it the web drew 8 aircraft where the mobile app drew
 * 13 for the same sky.
 *
 * Append-only, never overwrite: two sources for one aircraft is how a marker starts jittering
 * between them, and the server already picks between FR24's feed and our ADS-B before answering.
 */
async function livePositionsFromV2(): Promise<Map<string, {
  lat: number; lon: number; alt: number | null; gs: number | null; track: number | null
  fix_at: string | null; on_ground: boolean | null
}> | null> {
  try {
    const r = await fetch(`${V2_API}/v2/live`, { cache: 'no-store' })
    if (!r.ok) return null
    const body = await r.json()
    const out = new Map<string, any>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const f of (body?.flights ?? []) as any[]) {
      const cs = (f.callsign ?? '').trim().toUpperCase()
      const p = f.position
      if (!cs || !p) continue
      // On the ground is a real state but not a useful marker: the aircraft is at an airport the
      // map already draws, and a plane icon sitting on the field reads as a bug.
      if (p.on_ground) continue
      out.set(cs, {
        lat: p.lat, lon: p.lon, alt: p.altitude_ft ?? null,
        gs: p.ground_speed_kts ?? null, track: p.track_deg ?? null,
        fix_at: p.fix_at ?? null, on_ground: p.on_ground ?? null,
      })
    }
    return out
  } catch (e) {
    console.warn(`[airspace] v2 live unavailable (${e}) — circles only`)
    return null
  }
}

/**
 * The board layer from `flight`, three days of it, or null if the service cannot answer.
 *
 * This is the half of the map that was still reading `fr24_daily_cache` — a table warmed by
 * whichever visitor happens to open the site. It is why a flight could be airborne with the map
 * drawing nothing: XH728's cache row for 12 Aug carried the 11th's arrival times, so the map
 * treated a flight over Saudi Arabia as landed. The mobile map was moved off it on 13 Aug; this
 * is the same move for the web.
 *
 * Three dates because a flight that crosses midnight belongs to two of them, which is the reason
 * the cache path pulled three as well. v2's board already resolves what belongs to a given date,
 * so the day-window filtering the cache parser had to do is not repeated here — the downstream
 * `boardDeparted` filter still applies its own expiry rules.
 */
async function boardFromV2(dates: string[]): Promise<BoardFlight[] | null> {
  try {
    const pages = await Promise.all(dates.map(async d => {
      const r = await fetch(`${V2_API}/v2/board?date=${d}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`v2 board ${d} -> ${r.status}`)
      const body = await r.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((body?.flights ?? []) as any[]).map(f => ({ f, d }))
    }))

    /*
     * One row per CALLSIGN, ranked — not one per callsign-and-schedule.
     *
     * A daily rotation appears on two of the three dates: today's leg and tomorrow's. Keying the
     * dedup on iata_number plus sched_dep let both through, and `boardMap` keeps whichever it
     * sees last — tomorrow's, because of the order the dates are passed. FZ1192 was arriving at
     * Dubai while the map held its 14 Aug row, and inferDepartureTs then stamped a synthetic
     * departure onto it from the aircraft's position: a departure time in the future, on a
     * flight already nearly down.
     *
     * Ranked by rankInstance in lib/flight-status — airborne, then landed recently, then not yet
     * departed, then landed long ago. Ties go to the earlier date in the order passed.
     *
     * The rank that mattered here was the second one. This function used to score every completed
     * flight below tomorrow's untouched row, so on 14 Aug the map drew ABY433 and THY848 from
     * their 15 Aug rows: no actual times, no registration, and the wrong aircraft type. The popup
     * defects that surfaced them — one code instead of two, no photo, a countdown to an arrival
     * that had already happened — were all the same flight-that-had-not-happened-yet.
     */
    const best = new Map<string, { f: any; d: string; rank: number }>()
    const nowMs = Date.now()
    for (const { f, d } of pages.flat()) {
      const cs = (f.callsign ?? '').trim().toUpperCase()
      if (!cs) continue
      const rank = rankInstance(f, nowMs)
      const held = best.get(cs)
      if (!held || rank > held.rank) best.set(cs, { f, d, rank })
    }

    const out: BoardFlight[] = []
    for (const { f, d } of best.values()) {

      /*
       * Scheduled arrival as unix. v2 publishes it as UTC HH:MM plus arr_next_day rather than a
       * timestamp, so it is reassembled here against the board date it came from — the only
       * consumer is the HH:MM the map hands back, so a day-boundary slip would be visible and
       * harmless rather than silent.
       */
      let schedArr: number | null = null
      if (f.arr_time_utc) {
        const ms = Date.parse(`${d}T${f.arr_time_utc}:00Z`)
        if (Number.isFinite(ms)) schedArr = Math.floor((ms + (f.arr_next_day ? 86_400_000 : 0)) / 1000)
      }

      // The cache carried this ready-made; `flight` carries the two numbers it is made of.
      const depDelay = (f.sched_dep_unix && f.actual_dep_utc)
        ? Math.round((Date.parse(f.actual_dep_utc) / 1000 - f.sched_dep_unix) / 60)
        : null

      out.push({
        // `num` existed to match rows back into fr24_daily_cache for the departure writeback.
        // Nothing reads it on this path; the callsign keeps it a meaningful value rather than ''.
        num:             f.callsign ?? f.iata_number,
        flight_date:     d,
        iata_num:        f.iata_number,
        callsign:        f.callsign ?? '',
        dep_iata:        f.dep_iata ?? null,
        arr_iata:        f.arr_iata ?? null,
        sched_dep:       f.sched_dep_unix ?? null,
        sched_arr:       schedArr,
        duration_min:    f.duration_min ?? null,
        status:          (f.status ?? '').toLowerCase(),
        actual_dep_utc:  f.actual_dep_utc ?? null,
        actual_arr_utc:  f.actual_arr_utc ?? null,
        revised_arr_utc: f.revised_arr_utc ?? null,
        eta_stable_utc: f.eta_stable_utc ?? null,
        dep_delay_min:   depDelay,
        airline_iata:    f.airline_iata ?? null,
        reg:             f.aircraft_reg  ?? null,
        aircraft_type:   f.aircraft_type ?? null,
      })
    }
    return out.length ? out : null
  } catch (e) {
    console.warn(`[airspace] v2 board unavailable (${e}) — falling back to the cache`)
    return null
  }
}

let boardCache: { flights: BoardFlight[]; date: string; ts: number } | null = null

async function fetchBoardFlights(iataToIcao: Record<string, string>, lookup: CallsignLookup): Promise<BoardFlight[]> {
  const date = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
  if (boardCache && boardCache.date === date && Date.now() - boardCache.ts < 60_000)
    return boardCache.flights

  // Pull yesterday, today, and tomorrow so cross-midnight flights appear on both sides:
  // - Yesterday: departures from Syrian airports that are still airborne after midnight.
  // - Tomorrow:  arrivals at Syrian airports from non-Syrian origins that depart tonight
  //              but land just after Syria midnight (stored in tomorrow's cache by FR24).
  const yesterday         = new Date(Date.now() + 3 * 3_600_000 - 86_400_000).toISOString().slice(0, 10)
  const tomorrow          = new Date(Date.now() + 3 * 3_600_000 + 86_400_000).toISOString().slice(0, 10)
  // Syria midnight boundaries (UTC):
  //   syriaMidnightMs     = tonight's Syria midnight  (start of today's Syria date)
  //   tomorrowMidnightMs  = next Syria midnight         (start of tomorrow's Syria date)
  const syriaMidnightMs    = new Date(date     + 'T00:00:00+03:00').getTime()
  const tomorrowMidnightMs = new Date(tomorrow + 'T00:00:00+03:00').getTime()

  // Today first, so a midnight-crosser present on two pages keeps today's row.
  const v2 = await boardFromV2([date, yesterday, tomorrow])
  if (v2) {
    boardCache = { flights: v2, date, ts: Date.now() }
    return v2
  }

  /*
   * No fallback to fr24_daily_cache.
   *
   * There was one: when v2 could not answer, this parsed three days of the cache into the same
   * board shape. It went on 15 Aug, with the cache itself, and removing it was the point rather
   * than a side effect — a fallback onto a table nobody writes fails quietly, which is worse than
   * failing visibly. The last thing that filled it server-side (cron/fr24-sync) had never run, so
   * the fallback would have served data that aged without any surface saying so.
   *
   * What a reader sees when v2 is down: aircraft still draw, from the sweep and from
   * fr24_live_position, but without identity — no flight number, no route, no status. That is the
   * honest rendering of "we cannot reach the board", and the caller already treats an empty board
   * as a degraded state rather than an empty sky.
   *
   * The last good board is served first, so a brief blip costs nothing; only a sustained outage
   * empties it.
   */
  console.error('[airspace] v2 board unavailable — serving last known board, no cache fallback')
  return boardCache?.flights ?? []
}

// The per-callsign and per-hex adsb.fi lookups that used to live here are gone.
//
// They fanned out one HTTP request per flight, three at a time with a 300 ms sleep between
// rounds — about 53 callsigns a day, because ACTIVE_KEYWORDS matched 'estimated' and the
// daily cache stays "Estimated dep" all day. Measured cost: ~10 s per cache miss against a
// completely empty sky, on a request path that runs per visitor.
//
// Measured benefit: both loops only ever contributed aircraft the radius circles missed
// (`trackedExtra` skips anything already in `seenHex`). Over 7 days, of 7,983 aircraft in
// aircraft_last_seen, 13 were outside the circles — and the Turkey circle now covers 9 of
// those. Net unique yield: 4 aircraft in 7 days.
//
// What they were actually for is now done by the harvester, which writes every fix into
// fr24_live_position on its own sweep — server-side, one poll, and the same table the board
// reads, rather than a second position store per visitor.
/*
 * Positions now come from one place: fr24_live_position, via livePositionsFromV2 above.
 *
 * This is where flight_position_log used to be read. It held fixes written by whichever visitor
 * had the map open, joined against flight_signal_log to decide which of them to draw, and emitted
 * the result with board_match hardcoded true — so an aircraft with no board identity was still
 * published as one of ours. On 15 Aug that put an Israeli domestic flight on the map.
 *
 * The v2 block does the same job and refuses that case by construction: `if (!info) continue`,
 * identity from the board or nothing. It is also fresher — measured on the five flights this path
 * was serving at the time, fr24_live_position held fixes 49-120s old against browser rows minutes
 * older.
 */

// ── Persist last known positions ───────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
/**
 * A generous box around the Syria polygon, matching the cron's.
 *
 * One degree of margin, so an aircraft is already stored before it crosses the border and the
 * fallback can draw it the moment it does.
 */
const STORE_MARGIN_DEG = 1.0
const inStoreRegion = (lat: number, lon: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lon)
  && lat >= 32.0 - STORE_MARGIN_DEG && lat <= 37.7 + STORE_MARGIN_DEG
  && lon >= 35.3 - STORE_MARGIN_DEG && lon <= 42.7 + STORE_MARGIN_DEG

async function upsertPositions(aircraft: any[], ours: Set<string>): Promise<void> {
  /*
   * The same rule the poll cron applies, and for the same reason.
   *
   * This is the second writer into aircraft_last_seen, and when the cron was filtered this one
   * was not — the comment further down even asserted it "already saw the unfiltered set, so
   * aircraft_last_seen is unaffected", which was exactly backwards. Every request from every
   * open map wrote the whole feed back, so the table refilled with Ryanair and KLM within
   * hours of being cleaned out: 11,493 rows, 930 of them in ten minutes.
   *
   * Keep what could be drawn — inside the region, or a callsign the board knows.
   */
  aircraft = aircraft.filter(a =>
    inStoreRegion(a.lat, a.lon) || ours.has((a.flight ?? '').trim().toUpperCase()))

  if (!aircraft.length) return
  const now = new Date().toISOString()
  const rows = aircraft.map(a => ({
    hex:            a.hex,
    callsign:       (a.flight ?? '').trim() || null,
    lat:            a.lat,
    lon:            a.lon,
    alt_baro:       typeof a.alt_baro === 'number' ? a.alt_baro : null,
    gs:             a.gs    ?? null,
    track:          a.track ?? null,
    aircraft_type:  a.t     ?? null,
    registration:   a.r     ?? null,
    syria_airports: [],
    seen_at:        now,
    first_seen_at:  now,
    first_lat:      a.lat,
    first_lon:      a.lon,
    first_alt:      typeof a.alt_baro === 'number' ? a.alt_baro : null,
  }))
  for (let i = 0; i < rows.length; i += 200) {
    await fetch(`${SB_URL}/rest/v1/aircraft_last_seen`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(rows.slice(i, i + 200)),
    }).catch(() => {})
  }
}

// ── DB fallback when all ADS-B feeds are down ─────────────────────────────────
// Every row is resolved against the board. The previous version hardcoded
// `board_match: false` and left dep/arr null, which made the whole fallback a no-op: the
// client drops any aircraft without `board_match`, so the rows were queried, serialised,
// sent, and discarded on arrival. The enrichment is not cosmetic either — without
/** Longest credible block time on this network; AMS-DAM, the longest, is under 5 hours. */
const MAX_BLOCK_MIN = 12 * 60
/** How far a real en-route delay may stretch a scheduled block before we stop believing it. */
const MAX_DELAY_OVER_SCHED_MIN = 4 * 60

// dep_iata/arr_iata/duration_min/actual_dep_utc the ghost predictor and the path tracker
// have nothing to advance a marker along.
//
// Non-board rows are dropped here rather than shipped: they only feed the Over Syria view,
// which is a statement about who is in Syrian airspace *now* — a two-hour-old position
// cannot answer that. Dropping them also takes the payload from 500 rows to a handful.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// Takes the guarded lookup, not the raw map: these rows are stale by definition — up to two hours
// old — so a mismatched identity here outlives the fix that caused it.
async function fetchLastKnownPositions(matchLive: (cs: string) => BoardFlight | undefined): Promise<any[]> {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const res = await fetch(
    `${SB_URL}/rest/v1/aircraft_last_seen?seen_at=gte.${cutoff}&order=seen_at.desc&limit=500`,
    { headers: SB_HEADERS },
  )
  if (!res.ok) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await res.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const cs   = (r.callsign ?? '').trim().toUpperCase()
    const info = cs ? matchLive(cs) : undefined
    if (!info) continue
    // Rows are newest-first; keep only the most recent fix per callsign.
    if (seen.has(cs)) continue
    seen.add(cs)
    out.push({
      hex:            r.hex,
      flight:         cs,
      lat:            r.lat,
      lon:            r.lon,
      alt_baro:       r.alt_baro,
      gs:             r.gs,
      track:          r.track,
      t:              r.aircraft_type ?? info.aircraft_type ?? null,
      r:              r.registration  ?? info.reg           ?? null,
      board_match:    true,
      dep_iata:       info.dep_iata,
      arr_iata:       info.arr_iata,
      dep_time_utc:   info.sched_dep ? unixToHHMM(info.sched_dep) : null,
      arr_time_utc:   info.sched_arr ? unixToHHMM(info.sched_arr) : null,
      duration_min:   info.duration_min,
      iata_number:    info.iata_num,
      actual_dep_utc: info.actual_dep_utc,
      actual_arr_utc: info.actual_arr_utc,
      revised_arr_utc: info.revised_arr_utc ?? null,
      eta_stable_utc: info.eta_stable_utc ?? null,
      dep_delay_min:  info.dep_delay_min,
      airline_iata:   info.airline_iata,
      seen_at:        r.seen_at,
      stale:          true,
    })
  }
  return out
}

function unixToHHMM(unix: number): string {
  const d = new Date(unix * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// ── Radius feed in-flight dedup ───────────────────────────────────────────────
// `live` is false only when every mirror of every circle failed to answer — the signal
// that we are blind rather than looking at quiet sky.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let feedCache: { aircraft: any[]; live: boolean; ts: number; fromStorage: boolean } | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let feedInflight: Promise<{ aircraft: any[]; live: boolean }> | null = null

// ── Live ADS-B departure writeback ────────────────────────────────────────────
// writeInboundDep: UAE/Gulf radius sees an inbound flight airborne → write real_dep
//   to the arrival-airport (Syrian) cache row so future polls find it.
// writeOutboundDep: Syria radius sees an outbound flight airborne → write real_dep
//   to the departure-airport (Syrian) cache row so the ghost marker appears once
//   the plane leaves the radius.
// One write per callsign per Vercel instance lifetime (depSynced guard).
const SYRIAN_AIRPORTS_SET = SYRIA_AIRPORT_SET

/**
 * Estimate when a flight departed, for a board flight we have just seen airborne but for
 * which FR24 has published no departure yet.
 *
 * This used to answer `sched_dep`, which is the worst available guess: we are looking at
 * an aircraft that is airborne, and a delayed flight has by definition *not* left at its
 * scheduled time. JOC541/DN541 (OTP→DAM) departed 02:23:35 against a 02:00 schedule, so the
 * marker was drawn 24 minutes along the route the moment it was spotted, then snapped back
 * when the real departure was published. FYC486 (SAW→DAM, +31 min) did the same.
 *
 * We already know enough to do better: the aircraft's position gives progress along the
 * route, so `now − progress × block_time` recovers roughly when it started. Falls back to
 * the scheduled time only when the geometry is unavailable.
 *
 * Bounded to [now − block_time, now]: it cannot have departed in the future, nor been
 * airborne longer than the whole flight. Also not earlier than an hour before schedule —
 * a wildly-off position should degrade toward the timetable, not invent a departure that
 * never happened.
 */
function inferDepartureTs(
  info: BoardFlight,
  lat: number,
  lon: number,
  apCoords: Record<string, [number, number]>,
  nowSec: number,
): number {
  const dep = info.dep_iata ? apCoords[info.dep_iata] : undefined
  const arr = info.arr_iata ? apCoords[info.arr_iata] : undefined
  const blockSec = (info.duration_min ?? 0) * 60
  if (!dep || !arr || blockSec <= 0) return info.sched_dep ?? nowSec

  const total = haversineNm(dep[0], dep[1], arr[0], arr[1])
  if (total <= 0) return info.sched_dep ?? nowSec
  const remaining = haversineNm(lat, lon, arr[0], arr[1])
  const progress  = Math.max(0, Math.min(1, 1 - remaining / total))

  const est   = Math.round(nowSec - progress * blockSec)
  const floor = Math.max(nowSec - blockSec, (info.sched_dep ?? est) - 3600)
  return Math.max(floor, Math.min(est, nowSec))
}



/**
 * The cron's positions, read back.
 *
 * This is the point of the whole arrangement: /api/airspace answers from a table instead of
 * querying adsb.fi itself. Upstream traffic becomes a function of the cron's schedule rather
 * than of how many people have the map open, and a caller never waits for a sweep — measured
 * at ~13s when a lambda's in-process cache was cold, against ~2s warm.
 *
 * `raw` is the entire feed object, which is why this can stand in for a sweep at all: the
 * response ships fields the table has no columns for — t, r, track, true_heading — and a
 * reconstruction from the typed columns would quietly drop them.
 *
 * Bounded by seen_at, and that bound is load-bearing. aircraft_last_seen is upserted by hex,
 * so it holds every aircraft ever seen; without the window, one that left coverage hours ago
 * would still be drawn.
 */
const POSITION_MAX_AGE_MS = 75_000

const PAGE = 1_000

async function readStoredPositions(): Promise<{ aircraft: any[]; live: boolean; ts: number } | null> {
  const since = new Date(Date.now() - POSITION_MAX_AGE_MS).toISOString()

  /*
   * Paged, because PostgREST caps a response at 1000 rows and says so only by returning
   * exactly 1000. The first version of this read did not page, and the sky quietly shrank
   * from 1166 aircraft to 1000 — no error, no warning, just aircraft that stopped existing.
   * Whether the truncated set happens to contain the board's flights is luck.
   */
  const rows: { raw: any; seen_at: string }[] = []
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(
      `${SB_URL}/rest/v1/aircraft_last_seen?seen_at=gte.${since}&select=raw,seen_at&raw=not.is.null&order=seen_at.desc`,
      { headers: { ...SB_HEADERS, Range: `${from}-${from + PAGE - 1}` }, cache: 'no-store' },
    )
    if (!res.ok) return rows.length ? finish(rows) : null
    const page: { raw: any; seen_at: string }[] = await res.json()
    rows.push(...page)
    if (page.length < PAGE) break
    // A guard, not a limit anyone should reach: the feed runs to a few thousand aircraft, and
    // an unbounded loop against a table that is upserted continuously is not worth the risk.
    if (from >= 9 * PAGE) break
  }
  if (!rows.length) return null
  return finish(rows)
}

function finish(rows: { raw: any; seen_at: string }[]): { aircraft: any[]; live: boolean; ts: number } | null {

  const aircraft = rows.map(r => r.raw).filter(a => a && typeof a.lat === 'number')
  if (!aircraft.length) return null

  // Newest row, not now: the age reported to callers should be the age of the data.
  const newest = rows.reduce((t, r) => Math.max(t, Date.parse(r.seen_at)), 0)
  // Rows this recent mean the cron swept and at least one circle answered. Liveness is not
  // stored per row, and inferring it from their presence is exactly what it means.
  return { aircraft, live: true, ts: newest }
}

// Emergency fallback only: the cron owns the sweep now and writes to Supabase. This stays
// so a cron outage degrades to the old behaviour rather than a dark map, and it calls the
// shared sweep so the two can never disagree about which circles exist.
function refreshFeeds(): Promise<{ aircraft: unknown[]; live: boolean }> {
  const p = (async () => {
    const { aircraft, live } = await sweepAllCircles()
    feedCache = { aircraft, live, ts: Date.now(), fromStorage: false }
    feedInflight = null
    return { aircraft, live }
  })().catch(err => { feedInflight = null; throw err })
  return p
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET() {
  // Hoisted out of the try so the catch block can still resolve board metadata for the
  // DB fallback. An empty map there just means the fallback returns nothing, which is the
  // same as the old behaviour rather than a regression.
  const boardMap = new Map<string, BoardFlight>()
  /*
   * The board row for a callsign we are hearing right now.
   *
   * Every live fix goes through here rather than reading boardMap directly, so the one rule about
   * which identities a position may take lives in one place. boardMap itself is left whole: other
   * readers want the row whatever the clock says.
   */
  const NOW_FOR_MATCH = Date.now()
  const matchLive = (cs: string): BoardFlight | undefined => {
    const f = boardMap.get(cs)
    return f && couldBeAirborne(f, NOW_FOR_MATCH) ? f : undefined
  }
  try {
    const [iataToIcao, apCoords, lookup] = await Promise.all([
      fetchIataToIcao(), fetchAirportCoords(), fetchCallsignLookup(),
    ])
    const resolvedBoard = await fetchBoardFlights(iataToIcao, lookup)

    // callsign → board info
    for (const f of resolvedBoard) boardMap.set(f.callsign, f)

    /*
     * The callsigns the board knows, for the storage filter below.
     *
     * Taken from the resolved board rather than a fresh query: it is the same set, already
     * fetched, and it is what "our flights, wherever they are" means on this request.
     */
    const boardCallsignSet = new Set<string>(
      resolvedBoard.map(f => (f.callsign ?? '').trim().toUpperCase()).filter(Boolean),
    )

    // Radius feeds — stale-while-revalidate.
    //
    // adsb.fi allows 1 request/second, so the circles are queried sequentially and a full
    // sweep costs roughly (circles × 1.1s). Making the caller wait for that put user-visible
    // latency in direct proportion to coverage: measured 0.98–5.91 s on four circles, and it
    // was the reason for not adding the Gulf circle that RUH, KWI, DMM and BSR need.
    //
    // Serving the cached response and refreshing behind it breaks that link. Latency stops
    // depending on circle count, so coverage can be chosen on merit. FRESH_MS is when a
    // refresh is triggered; STALE_MS is how old data may be before a caller waits for it —
    // beyond that we would be showing a picture too old to be worth serving instantly.
    const FRESH_MS = 10_000
    const STALE_MS = 60_000
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let visualAircraft: any[]
    let feedsLive: boolean
    const cacheAge = feedCache ? Date.now() - feedCache.ts : Infinity

    /**
     * Three sources, in order of cost. A caller never sweeps unless the cron has stopped.
     *
     * `fromStorage` decides whether the positions are written back below. Re-upserting rows
     * that were just read would stamp seen_at with now, and an aircraft that left coverage
     * would then look freshly seen on every request — permanently.
     */
    let fromStorage = false

    if (feedCache && cacheAge < FRESH_MS) {
      visualAircraft = feedCache.aircraft
      feedsLive      = feedCache.live
      fromStorage    = feedCache.fromStorage
    } else {
      const stored = await readStoredPositions()
      if (stored) {
        visualAircraft = stored.aircraft
        feedsLive      = stored.live
        fromStorage    = true
        feedCache      = { ...stored, fromStorage: true }
      } else if (feedCache && cacheAge < STALE_MS) {
        // The cron has gone quiet but this instance still holds something recent. Serve it and
        // refresh behind the response rather than making this caller wait.
        visualAircraft = feedCache.aircraft
        feedsLive      = feedCache.live
        fromStorage    = feedCache.fromStorage
        if (!feedInflight) after(() => refreshFeeds().catch(() => {}))
      } else {
        // Nothing stored, nothing cached: the cron is down and this request is all there is.
        // The slow path survives for exactly this case.
        if (!feedInflight) feedInflight = refreshFeeds()
        const feed     = await feedInflight
        visualAircraft = feed.aircraft
        feedsLive      = feed.live
      }
    }

    // Nothing is persisted when the positions came out of the table: see fromStorage above.
    // The confirmed-airborne hex list that used to be fetched alongside this came from
    // flight_signal_log and existed only to pick which flight_position_log rows to draw.
    if (!fromStorage) await upsertPositions(visualAircraft, boardCallsignSet)

    // Annotate visual radius aircraft
    const seenHex = new Set<string>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotated: any[] = []
    for (const a of visualAircraft) {
      seenHex.add(a.hex)
      const cs   = (a.flight ?? '').trim().toUpperCase()
      const info = matchLive(cs)

      // Live departure confirmation — two cases, both require alt > 500 ft and gs > 80 kts:
      // 1. Inbound to Syrian airport: write real_dep to arrival-airport cache row.
      // 2. Outbound from Syrian airport: write real_dep to departure-airport cache row
      //    so the ghost marker appears once the plane leaves the Syria ADS-B radius.
      let actual_dep_utc = info?.actual_dep_utc ?? null
      const isAirborne = (a.alt_baro ?? 0) > 500 && (a.gs ?? 0) > 80

      /*
       * An aircraft cannot be operating a flight that has not been scheduled to leave yet.
       *
       * The board is keyed by callsign across yesterday, today and tomorrow, and today's row
       * wins the dedup. When yesterday's row is missing — FR24 files nothing for a flight it
       * never saw depart — a late aircraft still broadcasting that callsign matches TONIGHT's
       * row instead.
       *
       * FYC781 did exactly that on 6 Aug: yesterday's Damascus–Muscat ran about seven hours
       * late and was airborne at 04:18, while the only FYC781 in the cache was tonight's
       * 21:15. It was drawn en route with a +424 minute delay measured against a departure
       * still seventeen hours away, and worse, the writeback below would have stamped
       * tonight's row with a real departure — putting a flight on the board as departed, then
       * arrived, hours before it boards.
       *
       * Both harms are now prevented upstream instead of guarded here. boardFromV2 ranks the
       * instances of a callsign — airborne beats not-yet-departed beats arrived — so the
       * airborne row is the one that reaches this point, and tonight's is never matched to an
       * aircraft already in the air. The writeback that the second harm described is gone with
       * the cache it wrote to.
       *
       * Kept as a comment rather than deleted with the code: it is the case that motivated the
       * ranking, and the next person to touch instance selection should know FYC781 exists.
       */

      if (!actual_dep_utc && info && isAirborne) {
        if (info.arr_iata && SYRIAN_AIRPORTS_SET.has(info.arr_iata)
            && !SYRIAN_AIRPORTS_SET.has(info.dep_iata ?? '')) {
          // Inbound
          const depTs    = inferDepartureTs(info, a.lat, a.lon, apCoords, Math.floor(Date.now() / 1000))
          actual_dep_utc = new Date(depTs * 1000).toISOString()
          /*
           * The writeback is gone. It stamped this inferred departure into fr24_daily_cache so
           * the board would show it, and the board reads `flight` now — it was writing to a
           * table nothing consults. The inference stays: it is what draws the marker for a
           * flight FR24 has not yet declared departed.
           *
           * Note what is deliberately NOT replacing it. This never wrote to `flight` and should
           * not start: a departure guessed from a position is not the same fact as one FR24
           * published, and `flight` is the record of what is true. If inferred departures should
           * survive, they need a field that says they were inferred — `dep_confirmed` in the v2
           * contract already draws that line.
           */
        } else if (info.dep_iata && SYRIAN_AIRPORTS_SET.has(info.dep_iata)
            && !SYRIAN_AIRPORTS_SET.has(info.arr_iata ?? '')) {
          // Outbound
          const depTs    = inferDepartureTs(info, a.lat, a.lon, apCoords, Math.floor(Date.now() / 1000))
          actual_dep_utc = new Date(depTs * 1000).toISOString()
          // See above — the writeback is gone, the inference stays.
        }
      }

      annotated.push({
        ...a,
        board_match:    !!info,
        dep_iata:       info?.dep_iata       ?? null,
        arr_iata:       info?.arr_iata       ?? null,
        dep_time_utc:   info?.sched_dep      ? unixToHHMM(info.sched_dep) : null,
        arr_time_utc:   info?.sched_arr      ? unixToHHMM(info.sched_arr) : null,
        duration_min:   info?.duration_min   ?? null,
        iata_number:    info?.iata_num       ?? null,
        board_status:   info?.status         ?? null,
        actual_dep_utc,
        actual_arr_utc: info?.actual_arr_utc ?? null,
        revised_arr_utc: info?.revised_arr_utc ?? null,
        dep_delay_min:  info?.dep_delay_min  ?? null,
        airline_iata:   info?.airline_iata   ?? null,
      })
    }

    // Board flights located outside the radius circles. Sourced from the OpenSky poller
    // below rather than from per-flight adsb.fi lookups.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trackedExtra: any[] = []

    // Poller-written fixes for tracked flights that no radius circle found.
    //
    // Nothing in trackedExtra is fed back through upsertPositions: every source below is
    // already DB-derived (aircraft_last_seen), and writing a row back
    // would stamp seen_at = now, making a fix of known age look permanently current.
    const emittedCs = new Set<string>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      annotated.map((a: any) => (a.flight ?? '').trim().toUpperCase()),
    )
    /*
     * Flights FR24 can see and our receivers cannot.
     *
     * Added before the logged-position fallback below, because a live fix from the merged table
     * is better than a stored one — and `emittedCs` stops both paths emitting the same aircraft.
     */
    const v2Live = await livePositionsFromV2()
    if (v2Live) {
      for (const [cs, p] of v2Live) {
        if (emittedCs.has(cs)) continue          // we can hear it ourselves; that fix is fresher
        const info = matchLive(cs)
        if (!info) continue                      // identity comes from the board, never the fix
        emittedCs.add(cs)
        trackedExtra.push({
          hex:            null,
          flight:         cs,
          lat:            p.lat,
          lon:            p.lon,
          alt_baro:       p.alt,
          gs:             p.gs,
          track:          p.track,
          true_heading:   p.track,
          t:              info.aircraft_type ?? null,
          r:              info.reg           ?? null,
          // Not marked `fr24: true`: that flag means an out-of-band fix the client should
          // dead-reckon from. This one is current — the server discards anything older than
          // five minutes before publishing it.
          fix_at:         p.fix_at,
          board_match:    true,
          dep_iata:       info.dep_iata,
          arr_iata:       info.arr_iata,
          dep_time_utc:   info.sched_dep    ? unixToHHMM(info.sched_dep) : null,
          arr_time_utc:   info.sched_arr    ? unixToHHMM(info.sched_arr) : null,
          duration_min:   info.duration_min ?? null,
          iata_number:    info.iata_num     ?? null,
          board_status:   info.status       ?? null,
          actual_dep_utc: info.actual_dep_utc ?? null,
          actual_arr_utc: info.actual_arr_utc ?? null,
          revised_arr_utc: info.revised_arr_utc ?? null,
      eta_stable_utc: info.eta_stable_utc ?? null,
          dep_delay_min:  info.dep_delay_min  ?? null,
          airline_iata:   info.airline_iata   ?? null,
        })
      }
    }


    // Every circle failed — we are blind, not looking at empty sky. Fall back to the last
    // known position of each board flight so the map keeps its aircraft instead of
    // clearing. Marked stale with its own seen_at, so the client dead-reckons from the
    // fix's real age rather than pinning a marker to an hours-old position.
    //
    // Deliberately NOT fed through upsertPositions above: these rows came out of
    // aircraft_last_seen, and writing them back would stamp seen_at = now and make a stale
    // position look permanently fresh.
    if (!feedsLive) {
      for (const a of await fetchLastKnownPositions(matchLive)) {
        const cs = (a.flight ?? '').trim().toUpperCase()
        if (!cs || emittedCs.has(cs)) continue
        emittedCs.add(cs)
        trackedExtra.push(a)
      }
    }

    // Board flights confirmed departed but not found by any ADS-B feed
    // (no coverage over central Saudi Arabia, Iraqi desert, etc.).
    // Returned separately so the Map can drive ESTIMATED ghost markers
    // without a live position — the route_paths waypoints + actual_dep_utc
    // are enough to compute the correct enroute position.
    const seenCallsigns = new Set<string>([
      ...annotated.map((a: any) => (a.flight ?? '').trim().toUpperCase()),
      ...trackedExtra.map((a: any) => (a.flight ?? '').trim().toUpperCase()),
    ])
    // Include any board flight with a confirmed departure (or arrival) that is
    // not covered by a live ADS-B signal.  Flights with actual_arr_utc within
    // the last 4 h are included so the Map can show the ARRIVED state briefly.
    // This block does NOT synthesize a departure — it requires f.actual_dep_utc, which
    // comes from FR24's real_dep or a "Departed HH:MM" status. The only synthesis is in
    // the annotate loop above (inferDepartureTs), and it derives from position, not from
    // the scheduled time.
    const NOW_MS = Date.now()
    // Syria midnight = start of today's Syria date in UTC (e.g. 21:00 UTC yesterday)
    const syriaToday       = new Date(NOW_MS + 3 * 3_600_000).toISOString().slice(0, 10)
    const syriaMidnightMs  = new Date(syriaToday + 'T00:00:00+03:00').getTime()
    const boardDeparted = resolvedBoard
      .filter(f => {
        if (!f.dep_iata || !f.arr_iata || !f.duration_min) return false
        if (seenCallsigns.has(f.callsign)) return false
        // A diverted flight is going somewhere else and will never reach the destination on
        // its ticket, so predicting it along that route draws an aircraft on a path it has
        // already turned off. G9375 was over Jordan bound for Amman while both maps carried
        // it toward Damascus. Terminal here, like an arrival.
        if ((f.status ?? '').toLowerCase().includes('divert')) return false

        /*
         * An arrived flight stays on the map for an hour, then goes — whatever else is true of it.
         *
         * This test used to sit at the bottom, reachable only by a flight with no departure
         * record, so anything that had actually departed today returned true unconditionally and
         * was never removed. On 14 Aug that left eleven arrived markers stacked on Damascus, the
         * oldest landed 604 minutes earlier, overlapping into an unreadable pile.
         *
         * An hour is long enough that someone meeting a flight still sees it after it lands, and
         * short enough that the field does not silt up over a day. It leaves three at Damascus
         * where there were eleven.
         */
        if (f.actual_arr_utc) {
          return NOW_MS - new Date(f.actual_arr_utc).getTime() < ARRIVED_HOLD_MS
        }

        if (f.actual_dep_utc) {
          const depMs = new Date(f.actual_dep_utc).getTime()
          // Detect yesterday's flights: scheduled (or actual) departure is before Syria midnight
          const fromYesterday = f.sched_dep
            ? f.sched_dep * 1000 < syriaMidnightMs
            : depMs < syriaMidnightMs
          if (fromYesterday) {
            const estArrMs = depMs + f.duration_min * 60_000
            // Exclude flights that landed before Syria midnight (not cross-midnight)
            if (estArrMs <= syriaMidnightMs) return false
            // Exclude flights past their estimated arrival + 30-min buffer
            if (NOW_MS > estArrMs + 30 * 60_000) return false
          }
          return true
        }
        return false
      })
      .map(f => {
        const actual_dep_utc = f.actual_dep_utc
        return {
          callsign:        f.callsign,
          dep_iata:        f.dep_iata,
          arr_iata:        f.arr_iata,
          duration_min:    f.duration_min,
          // The timetable this flight was actually filed against. Without these the map had
          // to invent a schedule for any callsign it could not match to route_master, and
          // the placeholder it invented ('00:00') was then measured against — producing an
          // arrival "delay" of -246 minutes, which is simply the distance to midnight.
          dep_time_utc:    f.sched_dep ? unixToHHMM(f.sched_dep) : null,
          arr_time_utc:    f.sched_arr ? unixToHHMM(f.sched_arr) : null,
          actual_dep_utc,
          actual_arr_utc:  f.actual_arr_utc,
          revised_arr_utc: f.revised_arr_utc,
          iata_number:     f.iata_num,
          // The server's own verdict, which until now stopped at the board.
          //
          // The map computed its own from actual_arr_utc alone — `carriedArr ? 'Arrived' :
          // 'Departed'` — so an arrival the server infers from est_arr, where no arrival time is
          // ever published, reached the card and never the marker. FAD742 on 14 Aug read Arrived
          // in the list and "~ In air" in its popup an hour after it was down. Removing the
          // client's own stopwatch is what exposed it: before that, the map guessed its way to
          // roughly the right answer.
          status:          f.status,
          dep_delay_min:   f.dep_delay_min,
          airline_iata:    f.airline_iata,
          aircraft_reg:    f.reg,
          aircraft_type:   f.aircraft_type,
        }
      })

    // Non-board aircraft are consumed only by the Over Syria view, which discards
    // everything outside the Syria polygon. Shipping the rest to every visitor — an
    // audience that is ~72% mobile — is bandwidth spent on markers that are never drawn,
    // and adding the Turkey circle would have made that materially worse. Board-matched
    // aircraft are always kept, wherever they are. upsertPositions above applies the same
    // rule to what it stores — it used to store the unfiltered set, which quietly refilled
    // aircraft_last_seen with the whole continent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visible = annotated.filter((a: any) => a.board_match || inSyria(a.lat, a.lon))

    /*
     * One age for every aircraft, computed here so no surface has to work it out twice.
     *
     * The paths arrive with different clocks: the raw feed carries `seen`, seconds since the
     * receiver last heard it, while the v2 and logged-position paths carry a `fix_at` timestamp.
     * The marker faded on one signal and the side card had neither, so a flight could sit
     * motionless for half an hour with nothing on screen admitting it — ABY364 on 14 Aug showed
     * an altitude beside a fix 28 minutes old.
     *
     * Seconds, not a boolean. "Stale" is a threshold and every surface would pick its own;
     * an age lets the card say how long and the marker keep its own cutoff.
     */
    const nowSec = Date.now() / 1000
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withAge = (a: any) => {
      const fixMs = a.fix_at ? Date.parse(a.fix_at) : NaN
      const age = Number.isFinite(fixMs) ? (Date.now() - fixMs) / 1000
                : typeof a.seen === 'number' ? a.seen
                : null
      return { ...a, fix_age_s: age == null ? null : Math.round(age) }
    }
    void nowSec

    return NextResponse.json({
      ok:           true,
      aircraft:     [...visible, ...trackedExtra].map(withAge),
      boardDeparted,
      ts:           feedCache!.ts,
      // Enough to tell "the feeds returned nothing" from "we filtered it all out".
      feed_total:   annotated.length,
      // False means every circle failed and the aircraft above are last-known positions.
      feeds_live:   feedsLive,
    })
  } catch (err) {
    if (feedCache?.aircraft.length) {
      return NextResponse.json({ ok: true, aircraft: feedCache.aircraft, ts: feedCache.ts, warn: String(err) })
    }
    try {
      const dbAc = await fetchLastKnownPositions(matchLive)
      return NextResponse.json({ ok: true, aircraft: dbAc, ts: 0, warn: String(err), from_db: true, feeds_live: false })
    } catch {
      return NextResponse.json({ ok: false, aircraft: [], warn: String(err) })
    }
  }
}

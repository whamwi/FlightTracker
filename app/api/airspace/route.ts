import { NextResponse, after } from 'next/server'
import { sweepAllCircles } from '@/lib/adsb-feed'
import { fetchIataToIcao, fetchCallsignLookup, resolveCallsign, type CallsignLookup } from '@/lib/callsign'
import { SYRIA_AIRPORT_SET, SYRIA_AIRPORTS_CSV } from '@/lib/syria-airports'
import { inSyria } from '@/lib/syria-airspace'

export const dynamic = 'force-dynamic'

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

// ── Board flights (fr24_daily_cache, Syria op date = UTC+3, 60s cache) ────────
interface BoardFlight {
  num:            string        // raw FR24 value — used to match rows back into fr24_daily_cache
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
  dep_delay_min:   number | null // actual_dep_utc − sched_dep
  airline_iata:    string | null // IATA code for airline logo
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

  const res = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=in.(${yesterday},${date},${tomorrow})&airport_iata=in.(${SYRIA_AIRPORTS_CSV})&select=airport_iata,flight_date,departures,arrivals`,
    { headers: SB_HEADERS },
  )
  if (!res.ok) return boardCache?.flights ?? []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await res.json()

  // Today's rows first — ensures today's version of a flight wins the seen-set dedup
  // and yesterday's / tomorrow's identical entries are skipped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows.sort((a: any, b: any) => (a.flight_date === date ? -1 : 0) - (b.flight_date === date ? -1 : 0))

  // Reverse map: ICAO prefix → IATA (e.g. FYC→XH, THY→TK, FDB→FZ)
  const icaoToIata: Record<string, string> = {}
  for (const [iata, icao] of Object.entries(iataToIcao)) icaoToIata[icao] = iata

  const seen    = new Set<string>()
  const flights: BoardFlight[] = []

  for (const row of rows) {
    const ap = (row.airport_iata as string) || ''
    // Use the row's own flight_date for status string parsing so that "Departed HH:MM"
    // on yesterday's row is stamped on yesterday's date, not today's.
    const rowDate = (row.flight_date as string) || date
    for (const section of ['departures', 'arrivals'] as const) {
      for (const f of (row[section] ?? [])) {
        const num = (f.num ?? '').toString()
        if (!num) continue
        // Cross-midnight filtering for non-today rows.
        if (row.flight_date !== date) {
          if (row.flight_date === yesterday) {
            // Keep only flights still airborne after Syria midnight (sched_arr > tonight's midnight).
            if (!f.sched_arr || f.sched_arr * 1000 <= syriaMidnightMs) continue
          } else if (row.flight_date === tomorrow) {
            // Keep only inbound arrivals at Syrian airports that arrive within the first
            // 4 hours of tomorrow and haven't landed yet — departed tonight, cross midnight.
            if (section !== 'arrivals') continue
            if (!f.sched_arr || f.real_arr) continue
            const arrMs = (f.sched_arr as number) * 1000
            if (arrMs < tomorrowMidnightMs || arrMs >= tomorrowMidnightMs + 4 * 60 * 60 * 1000) continue
          } else {
            continue  // safety: ignore any unexpected date
          }
        }
        const key = `${num}|${f.sched_dep ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        const status         = (f.status ?? '').toLowerCase()
        const actual_dep_utc = f.real_dep
          ? new Date(f.real_dep * 1000).toISOString()
          : extractActualDepUtc(status, rowDate)
        const raw_actual_arr_utc = f.real_arr
          ? new Date(f.real_arr * 1000).toISOString()
          : extractActualArrUtc(status, rowDate)
        // Discarded when it implies an impossible block time, rather than only being
        // distrusted for the duration below. Both clients use this field DIRECTLY as the
        // arrival estimate that drives the tracker's rate — remaining path over remaining
        // time — so a revised arrival stamped a day late makes the marker crawl and the
        // aircraft appears to sit near its origin. Sanitising duration_min alone left that
        // path open: SYR522 read 180 minutes while still carrying a 2026-08-04 ETA.
        const revised_arr_raw = extractRevisedArrUtc(status, rowDate)
          ?? (f.est_arr ? new Date(f.est_arr * 1000).toISOString() : null)
        const revised_arr_utc = (() => {
          if (!revised_arr_raw || !actual_dep_utc) return revised_arr_raw
          const depMs = new Date(actual_dep_utc).getTime()
          const sched = f.duration_min ?? null
          const implausible = (mins: number) => !(mins > 0
            && mins <= MAX_BLOCK_MIN
            && (sched == null || mins <= sched + MAX_DELAY_OVER_SCHED_MIN))

          // Repair the date, do not discard the time.
          //
          // The failure is a whole-day offset: RB522's estimate arrived as 2026-08-04T20:35Z,
          // which is 23:35 in Damascus — the right time on the wrong day, and within two
          // minutes of the 23:33 the flight board shows. Dropping it lost a good ETA and sent
          // the map back to departure plus scheduled block, so the popup read 00:14 while the
          // board read 23:33. Shifting whole days keeps the estimate and its accuracy.
          let t = new Date(revised_arr_raw).getTime()
          for (let i = 0; i < 2 && (t - depMs) / 60_000 > MAX_BLOCK_MIN; i++) t -= 86_400_000
          for (let i = 0; i < 2 && t <= depMs; i++) t += 86_400_000

          const mins = Math.round((t - depMs) / 60_000)
          if (!implausible(mins)) {
            if (t !== new Date(revised_arr_raw).getTime()) {
              console.warn(`[airspace] ${num}: revised arrival re-dated ${revised_arr_raw} → ${new Date(t).toISOString()} (${mins}min after departure)`)
            }
            return new Date(t).toISOString()
          }
          console.warn(`[airspace] ${num}: discarding revised arrival ${revised_arr_raw} — implies ${mins}min (sched ${sched})`)
          return null
        })()
        // Prefer computed duration (actual_dep → revised_arr) over stale scheduled block time.
        const effectiveDurationMin = (() => {
          const sched = f.duration_min ?? null
          if (actual_dep_utc && revised_arr_utc) {
            const c = Math.round(
              (new Date(revised_arr_utc).getTime() - new Date(actual_dep_utc).getTime()) / 60_000
            )
            // The lower bound alone was not enough. A revised arrival stamped with the wrong
            // DATE lands exactly 1440 minutes out and was believed: SYR522 DOH-DAM came
            // through as a 1578-minute block against a scheduled 180, which put its ETA a day
            // away. Every consumer derives from this — the path tracker's rate is remaining
            // path over remaining time, so the marker crawled while the aircraft flew, and
            // drift grew without limit.
            //
            // Nothing on this network is close to 12 hours, and a real en-route delay does
            // not add four. Either bound catches the day-wrap; both are cheap.
            const plausible = c > 30
              && c <= MAX_BLOCK_MIN
              && (sched == null || c <= sched + MAX_DELAY_OVER_SCHED_MIN)
            if (plausible) return c
            console.warn(`[airspace] ${num}: implausible revised block ${c}min (sched ${sched}) — using schedule`)
          }
          return sched
        })()
        // Infer actual arrival when dep is confirmed + expected arr time is in the past.
        // When FR24 has its own ETA (revised_arr_utc), trust it — use a tight 15-min window.
        // Without an FR24 ETA we're working from the scheduled block time; use 90 min so a
        // delayed flight on final approach isn't prematurely marked as arrived and snapped to
        // the destination airport on the map while still airborne.
        const actual_arr_utc = raw_actual_arr_utc ?? (() => {
          if (!actual_dep_utc || !effectiveDurationMin || effectiveDurationMin <= 0) return null
          const expectedMs  = new Date(actual_dep_utc).getTime() + effectiveDurationMin * 60_000
          const thresholdMs = revised_arr_utc ? 15 * 60_000 : 90 * 60_000
          return expectedMs < Date.now() - thresholdMs ? new Date(expectedMs).toISOString() : null
        })()
        const schedDepMs   = f.sched_dep ? f.sched_dep * 1000 : null
        const actualDepMs  = actual_dep_utc ? new Date(actual_dep_utc).getTime() : null
        /*
         * A delay, or nothing — never a number this large.
         *
         * The same day-mismatch that put FYC781 on the wrong row produces delays measured
         * against a departure on another date. Four hours is already generous for this
         * network; beyond it the schedule is more likely wrong than the aircraft, and a
         * plainly absurd badge does more harm than an absent one. Same reasoning as the block
         * time bound above, which was added after SYR522 came through 1440 minutes out.
         */
        const rawDelay = (schedDepMs && actualDepMs)
          ? Math.round((actualDepMs - schedDepMs) / 60_000)
          : null
        const dep_delay_min = rawDelay !== null && Math.abs(rawDelay) > MAX_DELAY_OVER_SCHED_MIN
          ? null
          : rawDelay
        const callsignCs   = resolveCallsign(num, lookup, iataToIcao)
        const icaoPrefix   = callsignCs.replace(/\d/g, '')
        // FR24 cache omits the implicit airport — fill dep_iata for departures
        // and arr_iata for arrivals from the row's airport_iata.
        flights.push({
          num,
          iata_num:       lookup.toIata[num.toUpperCase()] ?? num,
          callsign:       callsignCs,
          dep_iata:       f.dep_iata || (section === 'departures' ? ap : null) || null,
          arr_iata:       f.arr_iata || (section === 'arrivals'   ? ap : null) || null,
          sched_dep:      f.sched_dep    ?? null,
          sched_arr:      f.sched_arr    ?? null,
          duration_min:   effectiveDurationMin,
          status,
          actual_dep_utc,
          actual_arr_utc,
          revised_arr_utc,
          dep_delay_min,
          airline_iata:   icaoToIata[icaoPrefix] ?? null,
        })
      }
    }
  }

  // ── Second pass: the other end of each flight ──────────────────────────────
  //
  // Everything above comes from DAM, ALP and LTK only, which is why the map disagreed with
  // the flight board about G9375: Damascus still read "Delayed 14:44" while Sharjah had
  // recorded the landing at 09:57:48, twelve seconds from the truth VariFlight confirmed.
  // The board reads origin airports in its own second pass; the map never did, so it went on
  // predicting an aircraft that had been on stand for an hour.
  //
  // Both directions, not just origins. For an arrival into Syria the origin's departures row
  // is the counterpart; for a departure out of Syria it is the destination's arrivals row —
  // and that is the row that knows when it landed. Airports elsewhere are also better
  // instrumented than ours, so their estimates tend to be fresher too.
  //
  // Fills gaps only. Where both ends report something, the first pass keeps its value: this
  // exists to supply what Syria does not know, not to arbitrate between two sources that
  // disagree, which today's evidence says cannot be done by preferring one airport.
  const counterparts = new Set<string>()
  // Keyed like the first pass, on number AND scheduled departure. The cache spans three
  // dates, and a flight number repeats daily: keyed on the number alone, yesterday's Sharjah
  // row matched today's leg and handed ABY375 an arrival from the day before. sched_dep is a
  // unix instant, so both ends of the same leg agree on it.
  const byNum = new Map<string, BoardFlight>()
  for (const f of flights) {
    const k = `${f.num}|${f.sched_dep ?? ''}`
    if (!byNum.has(k)) byNum.set(k, f)
    const dep = f.dep_iata ?? '', arr = f.arr_iata ?? ''
    const other = SYRIA_AIRPORTS.has(arr) ? dep : SYRIA_AIRPORTS.has(dep) ? arr : ''
    if (other && !SYRIA_AIRPORTS.has(other)) counterparts.add(other)
  }

  if (counterparts.size) {
    const codes = [...counterparts].join(',')
    const res2 = await fetch(
      `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=in.(${yesterday},${date},${tomorrow})&airport_iata=in.(${codes})&select=airport_iata,flight_date,departures,arrivals`,
      { headers: SB_HEADERS },
    )
    if (res2.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows2: any[] = await res2.json()
      let filled = 0
      for (const row of rows2) {
        const rowDate = (row.flight_date as string) || date
        for (const section of ['departures', 'arrivals'] as const) {
          for (const f of (row[section] ?? [])) {
            const num = (f.num ?? '').toString()
            const hit = num && byNum.get(`${num}|${f.sched_dep ?? ''}`)
            if (!hit) continue
            const st = (f.status ?? '').toLowerCase()

            if (!hit.actual_arr_utc) {
              const arr = f.real_arr
                ? new Date(f.real_arr * 1000).toISOString()
                : extractActualArrUtc(st, rowDate)
              // An arrival before its own departure belongs to another leg. The key should
              // already prevent that; this catches it when a row carries no sched_dep to key
              // on, which is how yesterday's landing reached today's flight.
              const sane = arr && hit.actual_dep_utc
                ? Date.parse(arr) > Date.parse(hit.actual_dep_utc)
                : !!arr
              if (arr && sane) { hit.actual_arr_utc = arr; filled++ }
            }
            if (!hit.actual_dep_utc) {
              const dep = f.real_dep
                ? new Date(f.real_dep * 1000).toISOString()
                : extractActualDepUtc(st, rowDate)
              if (dep) hit.actual_dep_utc = dep
            }
            if (!hit.revised_arr_utc && f.est_arr) {
              hit.revised_arr_utc = new Date(f.est_arr * 1000).toISOString()
            }
          }
        }
      }
      if (filled) console.log(`[airspace] second pass supplied ${filled} arrival(s) Syria had not recorded`)
    }
  }

  boardCache = { flights, date, ts: Date.now() }
  return flights
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
// What they were actually for is now done properly by /api/cron/opensky-poll: one request,
// one credit, every tracked hex at once, global, no radius limit, on a cron rather than
// per visitor. fetchLoggedPositions below surfaces its fixes to the map.
interface SignalFlight { callsign: string; hex: string; dep_iata: string | null; arr_iata: string | null; flight_date: string }

// ── Poller-written positions (10s cache) ──────────────────────────────────────
// /api/cron/opensky-poll writes flight_position_log on a cron for every tracked hex,
// worldwide. OpenSky sees traffic the volunteer ADS-B networks miss over this region, so
// these rows are often the only live fix a flight has. Reading them here is a DB hit
// rather than an upstream call, so the cost does not scale with visitor count — which is
// the point of polling on a cron instead of from the browser.
//
// A row can be up to one poll interval old, so it is emitted as an out-of-band fix
// carrying its own capture time (`fix_at`) rather than as a current position: the client
// dead-reckons forward from it instead of assuming the aircraft is there now.
//
// This window MUST stay above the cron interval in vercel.json, or fixes age out before
// the next poll replaces them and the channel goes dark for part of every cycle with no
// error anywhere — the window was 6 min while the cron ran every 2, and moving the cron
// to 15 without this would have blanked it for two thirds of each interval.
// It must also stay under FR24_HAND_OFF_MS (30 min) in Map.tsx, which retires a fix
// client-side; a row older than that would be dropped on arrival instead.
const OPENSKY_POLL_INTERVAL_MS = 15 * 60_000          // keep in sync with vercel.json
const LOGGED_MAX_AGE_MS        = OPENSKY_POLL_INTERVAL_MS + 5 * 60_000

interface LoggedPos {
  callsign:    string
  lat:         number
  lon:         number
  alt_baro:    number | null
  gs:          number | null
  track:       number | null
  hex:         string | null
  captured_at: string
}
let loggedCache: { map: Record<string, LoggedPos>; ts: number } | null = null

async function fetchLoggedPositions(): Promise<Record<string, LoggedPos>> {
  if (loggedCache && Date.now() - loggedCache.ts < 10_000) return loggedCache.map
  const cutoff = new Date(Date.now() - LOGGED_MAX_AGE_MS).toISOString()
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/flight_position_log`
      + `?captured_at=gte.${cutoff}&order=captured_at.desc&limit=500`
      + `&select=callsign,lat,lon,alt_baro,gs,track,hex,captured_at`,
      { headers: SB_HEADERS, signal: AbortSignal.timeout(5000) },
    )
    const rows: LoggedPos[] = res.ok ? await res.json() : []
    const map: Record<string, LoggedPos> = {}
    // Newest-first, so the first row seen for a callsign is its latest fix.
    for (const r of rows) {
      if (!r.callsign || r.lat == null || r.lon == null) continue
      if (!map[r.callsign]) map[r.callsign] = r
    }
    loggedCache = { map, ts: Date.now() }
    return map
  } catch { return loggedCache?.map ?? {} }
}

// Fetch today's confirmed-airborne flights with hex codes from flight_signal_log
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let signalCache: { flights: SignalFlight[]; ts: number } | null = null
async function fetchSignalFlights(): Promise<SignalFlight[]> {
  if (signalCache && Date.now() - signalCache.ts < 30_000) return signalCache.flights
  const today   = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
  // Only include flights that became airborne within the last 6 hours — the longest
  // Syrian route is DAM→AMS at ~4.5h, so 6h gives a 1.5h buffer before we stop tracking.
  // Using airborne_at, not last_seen_at: a flight leaving the Syria radius 20 min after
  // takeoff would have last_seen ~2h ago on a 3h flight, which a last_seen cutoff would
  // incorrectly exclude. Sort by airborne_at desc so same-hex aircraft (two legs same day)
  // yield the most recent leg first — the seenHex dedup then keeps the right one.
  const cutoff  = new Date(Date.now() - 6 * 3_600_000).toISOString()
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/flight_signal_log`
      + `?flight_date=eq.${today}&actual_arr_at=is.null&airborne_at=not.is.null&hex=not.is.null`
      + `&airborne_at=gte.${cutoff}`
      + `&order=airborne_at.desc`
      + `&select=callsign,hex,dep_iata,arr_iata,flight_date`,
      { headers: SB_HEADERS, signal: AbortSignal.timeout(5000) }
    )
    const flights: SignalFlight[] = res.ok ? await res.json() : []
    signalCache = { flights, ts: Date.now() }
    return flights
  } catch { return signalCache?.flights ?? [] }
}

// ── Persist last known positions ───────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertPositions(aircraft: any[]): Promise<void> {
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
async function fetchLastKnownPositions(boardMap: Map<string, BoardFlight>): Promise<any[]> {
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
    const info = cs ? boardMap.get(cs) : undefined
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
      t:              r.aircraft_type,
      r:              r.registration,
      board_match:    true,
      dep_iata:       info.dep_iata,
      arr_iata:       info.arr_iata,
      dep_time_utc:   info.sched_dep ? unixToHHMM(info.sched_dep) : null,
      arr_time_utc:   info.sched_arr ? unixToHHMM(info.sched_arr) : null,
      duration_min:   info.duration_min,
      iata_number:    info.iata_num,
      actual_dep_utc: info.actual_dep_utc,
      actual_arr_utc: info.actual_arr_utc,
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
const depSynced = new Set<string>()

/**
 * Estimate when a flight departed, for a board flight we have just seen airborne but for
 * which FR24 has published no departure yet.
 *
 * This used to answer `sched_dep`, which is the worst available guess: we are looking at
 * an aircraft that is airborne, and a delayed flight has by definition *not* left at its
 * scheduled time. JOC541/DN541 (OTP→DAM) departed 02:23:35 against a 02:00 schedule, so the
 * marker was drawn 24 minutes along the route the moment it was spotted, then snapped back
 * when fr24-sync published the real departure. FYC486 (SAW→DAM, +31 min) did the same.
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

async function writeInboundDep(info: BoardFlight, depTs: number): Promise<void> {
  const arrAp = info.arr_iata
  if (!arrAp || !SYRIAN_AIRPORTS_SET.has(arrAp)) return
  const date = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
  const rowRes = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache?airport_iata=eq.${arrAp}&flight_date=eq.${date}&select=arrivals,departures`,
    { headers: SB_HEADERS },
  )
  if (!rowRes.ok) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await rowRes.json()
  if (!rows.length) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = ((rows[0].arrivals ?? []) as any[]).map((f: any) =>
    f.num === info.num ? { ...f, real_dep: depTs } : f,
  )
  await fetch(`${SB_URL}/rest/v1/fr24_daily_cache`, {
    method:  'POST',
    headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ airport_iata: arrAp, flight_date: date, arrivals: list, departures: rows[0].departures ?? [] }),
  })
}

async function writeOutboundDep(info: BoardFlight, depTs: number): Promise<void> {
  const depAp = info.dep_iata
  if (!depAp || !SYRIAN_AIRPORTS_SET.has(depAp)) return
  const date = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
  const rowRes = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache?airport_iata=eq.${depAp}&flight_date=eq.${date}&select=arrivals,departures`,
    { headers: SB_HEADERS },
  )
  if (!rowRes.ok) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await rowRes.json()
  if (!rows.length) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = ((rows[0].departures ?? []) as any[]).map((f: any) =>
    f.num === info.num ? { ...f, real_dep: depTs } : f,
  )
  await fetch(`${SB_URL}/rest/v1/fr24_daily_cache`, {
    method:  'POST',
    headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ airport_iata: depAp, flight_date: date, arrivals: rows[0].arrivals ?? [], departures: list }),
  })
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
  try {
    const [iataToIcao, apCoords, lookup] = await Promise.all([
      fetchIataToIcao(), fetchAirportCoords(), fetchCallsignLookup(),
    ])
    const resolvedBoard = await fetchBoardFlights(iataToIcao, lookup)

    // callsign → board info
    for (const f of resolvedBoard) boardMap.set(f.callsign, f)

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

    // Confirmed-airborne hex list, fetched in parallel with the position persist.
    // Nothing is persisted when the positions came out of the table: see fromStorage above.
    const [signalFlights] = await Promise.all([
      fetchSignalFlights(),
      fromStorage ? Promise.resolve() : upsertPositions(visualAircraft),
    ] as const)

    // Annotate visual radius aircraft
    const seenHex = new Set<string>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotated: any[] = []
    for (const a of visualAircraft) {
      seenHex.add(a.hex)
      const cs   = (a.flight ?? '').trim().toUpperCase()
      const info = boardMap.get(cs)

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
       * An hour of tolerance, because a flight that leaves slightly early is ordinary and a
       * flight that leaves a day early is not.
       */
      const schedDepMs   = info?.sched_dep ? info.sched_dep * 1000 : null
      const notYetDue    = schedDepMs !== null && schedDepMs > Date.now() + 60 * 60_000

      if (!actual_dep_utc && info && isAirborne) {
        if (info.arr_iata && SYRIAN_AIRPORTS_SET.has(info.arr_iata)
            && !SYRIAN_AIRPORTS_SET.has(info.dep_iata ?? '')) {
          // Inbound
          const depTs    = inferDepartureTs(info, a.lat, a.lon, apCoords, Math.floor(Date.now() / 1000))
          actual_dep_utc = new Date(depTs * 1000).toISOString()
          // Not written back when the matched row is still in the future: stamping real_dep
          // there would put tonight's flight on the board as departed, then arrived, hours
          // before it boards. The marker is drawn either way — the aircraft is real.
          if (!depSynced.has(cs) && !notYetDue) {
            depSynced.add(cs)
            writeInboundDep(info, depTs).catch(() => {})
          }
        } else if (info.dep_iata && SYRIAN_AIRPORTS_SET.has(info.dep_iata)
            && !SYRIAN_AIRPORTS_SET.has(info.arr_iata ?? '')) {
          // Outbound
          const depTs    = inferDepartureTs(info, a.lat, a.lon, apCoords, Math.floor(Date.now() / 1000))
          actual_dep_utc = new Date(depTs * 1000).toISOString()
          // See above — no writeback onto a flight that has not left yet.
          if (!depSynced.has(cs) && !notYetDue) {
            depSynced.add(cs)
            writeOutboundDep(info, depTs).catch(() => {})
          }
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
        actual_dep_utc,
        actual_arr_utc: info?.actual_arr_utc ?? null,
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
    // already DB-derived (flight_position_log, aircraft_last_seen), and writing a row back
    // would stamp seen_at = now, making a fix of known age look permanently current.
    const emittedCs = new Set<string>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      annotated.map((a: any) => (a.flight ?? '').trim().toUpperCase()),
    )
    const loggedMap = await fetchLoggedPositions()
    for (const sig of signalFlights) {
      const cs = sig.callsign.trim().toUpperCase()
      if (emittedCs.has(cs)) continue
      if (sig.hex && seenHex.has(sig.hex.toLowerCase())) continue
      const p = loggedMap[sig.callsign] ?? loggedMap[cs]
      if (!p) continue
      emittedCs.add(cs)
      if (p.hex) seenHex.add(p.hex.toLowerCase())
      const info = boardMap.get(cs)
      trackedExtra.push({
        hex:            p.hex ?? sig.hex,
        flight:         cs,
        lat:            p.lat,
        lon:            p.lon,
        alt_baro:       p.alt_baro,
        gs:             p.gs,
        track:          p.track,
        true_heading:   p.track,
        t:              null,
        r:              null,
        fr24:           true,          // out-of-band fix: dead-reckon from fix_at, don't treat as live
        fix_at:         p.captured_at,
        board_match:    true,
        dep_iata:       sig.dep_iata,
        arr_iata:       sig.arr_iata,
        dep_time_utc:   info?.sched_dep    ? unixToHHMM(info.sched_dep) : null,
        arr_time_utc:   info?.sched_arr    ? unixToHHMM(info.sched_arr) : null,
        duration_min:   info?.duration_min ?? null,
        iata_number:    info?.iata_num     ?? null,
        actual_dep_utc: info?.actual_dep_utc ?? null,
        actual_arr_utc: info?.actual_arr_utc ?? null,
        dep_delay_min:  info?.dep_delay_min  ?? null,
        airline_iata:   info?.airline_iata   ?? null,
      })
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
      for (const a of await fetchLastKnownPositions(boardMap)) {
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
        // Already landed without a departure record — still show ARRIVED for 4 h
        if (f.actual_arr_utc && NOW_MS - new Date(f.actual_arr_utc).getTime() < 4 * 3_600_000) return true
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
          dep_delay_min:   f.dep_delay_min,
          airline_iata:    f.airline_iata,
        }
      })

    // Non-board aircraft are consumed only by the Over Syria view, which discards
    // everything outside the Syria polygon. Shipping the rest to every visitor — an
    // audience that is ~72% mobile — is bandwidth spent on markers that are never drawn,
    // and adding the Turkey circle would have made that materially worse. Board-matched
    // aircraft are always kept, wherever they are. upsertPositions above already saw the
    // unfiltered set, so aircraft_last_seen is unaffected.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visible = annotated.filter((a: any) => a.board_match || inSyria(a.lat, a.lon))

    return NextResponse.json({
      ok:           true,
      aircraft:     [...visible, ...trackedExtra],
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
      const dbAc = await fetchLastKnownPositions(boardMap)
      return NextResponse.json({ ok: true, aircraft: dbAc, ts: 0, warn: String(err), from_db: true, feeds_live: false })
    } catch {
      return NextResponse.json({ ok: false, aircraft: [], warn: String(err) })
    }
  }
}

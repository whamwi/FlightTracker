import { NextResponse, after } from 'next/server'
import { sweepAllCircles } from '@/lib/adsb-feed'

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
const SYRIA_BOX = { latMin: 32.0, latMax: 37.7, lonMin: 35.3, lonMax: 42.7 }
function inSyriaBox(lat: number, lon: number): boolean {
  return lat >= SYRIA_BOX.latMin && lat <= SYRIA_BOX.latMax
      && lon >= SYRIA_BOX.lonMin && lon <= SYRIA_BOX.lonMax
}

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
let iataToIcaoCache: { map: Record<string, string>; ts: number } | null = null

async function fetchIataToIcao(): Promise<Record<string, string>> {
  if (iataToIcaoCache && Date.now() - iataToIcaoCache.ts < 3_600_000)
    return iataToIcaoCache.map
  const res = await fetch(`${SB_URL}/rest/v1/airlines?select=iata,icao`, { headers: SB_HEADERS })
  if (!res.ok) return iataToIcaoCache?.map ?? {}
  const rows: { iata: string; icao: string }[] = await res.json()
  const map: Record<string, string> = {}
  for (const r of rows) if (r.iata && r.icao) map[r.iata.toUpperCase()] = r.icao.toUpperCase()
  iataToIcaoCache = { map, ts: Date.now() }
  return map
}

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

// ── Per-flight callsign lookup (1h cache) ─────────────────────────────────────
// `flight_lookup` is the authoritative iata_number → broadcast_callsign mapping, kept by
// the admin tooling and the damairport sync. It is what /api/schedule and route-reconcile
// read, and it is right where the prefix rule below is only a guess.
//
// That guess fails whenever an airline's callsign is not <ICAO><same digits>: DN541 is
// broadcast as DNA541, and `airlines` said DN→JOC, so every Dan Air flight failed to match
// its own ADS-B contact for two weeks with no error anywhere — indistinguishable from an
// aircraft simply not being seen.
//
// FR24's `num` arrives in either form — IATA (XQ808) or already the callsign (FYC455, where
// flight_lookup.fr24_uses_callsign is true) — so both are indexed.
interface CallsignLookup {
  byIata:     Record<string, string>   // XQ808  → SXS808
  byCallsign: Record<string, string>   // FYC455 → FYC455
  // Either identifier → the real IATA number. FR24 publishes the callsign as `num` for the
  // 38 flights with fr24_uses_callsign, so `num` alone cannot tell you the ticketed number:
  // Fly Cham arrives as FYC727 when a passenger's booking says XH727.
  toIata:     Record<string, string>   // FYC727 → XH727,  XQ808 → XQ808
}
let lookupCache: { map: CallsignLookup; ts: number } | null = null

async function fetchCallsignLookup(): Promise<CallsignLookup> {
  if (lookupCache && Date.now() - lookupCache.ts < 3_600_000) return lookupCache.map
  const res = await fetch(
    `${SB_URL}/rest/v1/flight_lookup?select=iata_number,broadcast_callsign&broadcast_callsign=not.is.null`,
    { headers: SB_HEADERS },
  )
  if (!res.ok) return lookupCache?.map ?? { byIata: {}, byCallsign: {}, toIata: {} }
  const rows: { iata_number: string; broadcast_callsign: string }[] = await res.json()
  const map: CallsignLookup = { byIata: {}, byCallsign: {}, toIata: {} }
  for (const r of rows) {
    if (!r.iata_number || !r.broadcast_callsign) continue
    map.byIata[r.iata_number.toUpperCase()]            = r.broadcast_callsign.toUpperCase()
    map.byCallsign[r.broadcast_callsign.toUpperCase()] = r.broadcast_callsign.toUpperCase()
    map.toIata[r.iata_number.toUpperCase()]            = r.iata_number
    map.toIata[r.broadcast_callsign.toUpperCase()]     = r.iata_number
  }
  lookupCache = { map, ts: Date.now() }
  return map
}

/** Table first, prefix rule only for flights the table has never seen. */
function resolveCallsign(num: string, lookup: CallsignLookup, iataToIcao: Record<string, string>): string {
  const up = num.toUpperCase()
  return lookup.byIata[up] ?? lookup.byCallsign[up] ?? toCallsign(up, iataToIcao)
}

// Convert FR24 flight number → ADS-B broadcast callsign.
// FR24 uses IATA format (TK849, G9434, FZ1234) or already-ICAO (FYC490, SYR123).
// ADS-B always broadcasts ICAO prefix (THY849, ABY434, FDB1234, FYC490).
// Fallback only — prefer resolveCallsign above.
function toCallsign(num: string, iataToIcao: Record<string, string>): string {
  const up = num.toUpperCase()
  // 2-char alphanumeric IATA prefix: "TK"→THY, "G9"→ABY, "FZ"→FDB
  const m2 = up.match(/^([A-Z][A-Z0-9])(\d+)$/)
  if (m2) {
    const icao = iataToIcao[m2[1]]
    if (icao) return icao + m2[2]
  }
  // 3-char alpha — already ICAO (FYC490, SYR123) or unknown; return as-is
  return up
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
    `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=in.(${yesterday},${date},${tomorrow})&airport_iata=in.(DAM,ALP,LTK)&select=airport_iata,flight_date,departures,arrivals`,
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
        const revised_arr_utc = extractRevisedArrUtc(status, rowDate)
          ?? (f.est_arr ? new Date(f.est_arr * 1000).toISOString() : null)
        // Prefer computed duration (actual_dep → revised_arr) over stale scheduled block time.
        const effectiveDurationMin = (() => {
          if (actual_dep_utc && revised_arr_utc) {
            const c = Math.round(
              (new Date(revised_arr_utc).getTime() - new Date(actual_dep_utc).getTime()) / 60_000
            )
            if (c > 30) return c
          }
          return f.duration_min ?? null
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
        const dep_delay_min = (schedDepMs && actualDepMs)
          ? Math.round((actualDepMs - schedDepMs) / 60_000)
          : null
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
let feedCache: { aircraft: any[]; live: boolean; ts: number } | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let feedInflight: Promise<{ aircraft: any[]; live: boolean }> | null = null

// ── Live ADS-B departure writeback ────────────────────────────────────────────
// writeInboundDep: UAE/Gulf radius sees an inbound flight airborne → write real_dep
//   to the arrival-airport (Syrian) cache row so future polls find it.
// writeOutboundDep: Syria radius sees an outbound flight airborne → write real_dep
//   to the departure-airport (Syrian) cache row so the ghost marker appears once
//   the plane leaves the radius.
// One write per callsign per Vercel instance lifetime (depSynced guard).
const SYRIAN_AIRPORTS_SET = new Set(['DAM', 'ALP', 'LTK'])
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

// Emergency fallback only: the cron owns the sweep now and writes to Supabase. This stays
// so a cron outage degrades to the old behaviour rather than a dark map, and it calls the
// shared sweep so the two can never disagree about which circles exist.
function refreshFeeds(): Promise<{ aircraft: unknown[]; live: boolean }> {
  const p = (async () => {
    const { aircraft, live } = await sweepAllCircles()
    feedCache = { aircraft, live, ts: Date.now() }
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

    if (feedCache && cacheAge < FRESH_MS) {
      visualAircraft = feedCache.aircraft
      feedsLive      = feedCache.live
    } else if (feedCache && cacheAge < STALE_MS) {
      // Serve now, refresh after the response is sent. `after()` keeps the function alive
      // past the response on Vercel; without it the work would be frozen mid-flight.
      visualAircraft = feedCache.aircraft
      feedsLive      = feedCache.live
      if (!feedInflight) after(() => refreshFeeds().catch(() => {}))
    } else {
      if (!feedInflight) feedInflight = refreshFeeds()
      const feed     = await feedInflight
      visualAircraft = feed.aircraft
      feedsLive      = feed.live
    }

    // Confirmed-airborne hex list, fetched in parallel with the position persist
    const [signalFlights] = await Promise.all([
      fetchSignalFlights(),
      upsertPositions(visualAircraft),
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
      if (!actual_dep_utc && info && isAirborne) {
        if (info.arr_iata && SYRIAN_AIRPORTS_SET.has(info.arr_iata)
            && !SYRIAN_AIRPORTS_SET.has(info.dep_iata ?? '')) {
          // Inbound
          const depTs    = inferDepartureTs(info, a.lat, a.lon, apCoords, Math.floor(Date.now() / 1000))
          actual_dep_utc = new Date(depTs * 1000).toISOString()
          if (!depSynced.has(cs)) {
            depSynced.add(cs)
            writeInboundDep(info, depTs).catch(() => {})
          }
        } else if (info.dep_iata && SYRIAN_AIRPORTS_SET.has(info.dep_iata)
            && !SYRIAN_AIRPORTS_SET.has(info.arr_iata ?? '')) {
          // Outbound
          const depTs    = inferDepartureTs(info, a.lat, a.lon, apCoords, Math.floor(Date.now() / 1000))
          actual_dep_utc = new Date(depTs * 1000).toISOString()
          if (!depSynced.has(cs)) {
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
    const visible = annotated.filter((a: any) => a.board_match || inSyriaBox(a.lat, a.lon))

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

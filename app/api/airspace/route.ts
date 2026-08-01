import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL     = process.env.SUPABASE_URL!
const SB_KEY     = process.env.SUPABASE_ANON_KEY!
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

// ── Visual radius feeds ───────────────────────────────────────────────────────
// Syria + neighbors: covers DAM, ALP, TK routes, LB, JO, IQ border traffic.
// UAE + Gulf: covers DXB, AUH, SHJ, DOH, BAH, KWI, MCT.
const FEEDS_SYRIA: string[] = [
  'https://opendata.adsb.fi/api/v2/lat/33.0/lon/38.0/dist/700',
  'https://api.adsb.lol/v2/lat/33.0/lon/38.0/dist/700',
]
const FEEDS_UAE: string[] = [
  'https://opendata.adsb.fi/api/v2/lat/25.0/lon/55.0/dist/400',
  'https://api.adsb.lol/v2/lat/25.0/lon/55.0/dist/400',
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchRadiusFeed(feeds: string[]): Promise<any[]> {
  for (const url of feeds) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'FlightTracker/1.0' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) continue
      const json = await res.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (json.ac ?? []).filter((a: any) => a.lat != null && a.lon != null)
    } catch { /* try next */ }
  }
  return []
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

// Convert FR24 flight number → ADS-B broadcast callsign.
// FR24 uses IATA format (TK849, G9434, FZ1234) or already-ICAO (FYC490, SYR123).
// ADS-B always broadcasts ICAO prefix (THY849, ABY434, FDB1234, FYC490).
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
  num:            string
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

async function fetchBoardFlights(iataToIcao: Record<string, string>): Promise<BoardFlight[]> {
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
        const callsignCs   = toCallsign(num, iataToIcao)
        const icaoPrefix   = callsignCs.replace(/\d/g, '')
        // FR24 cache omits the implicit airport — fill dep_iata for departures
        // and arr_iata for arrivals from the row's airport_iata.
        flights.push({
          num,
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

// ── Callsign-based ADS-B lookup for active flights (10s cache) ────────────────
// Active = FR24 status suggests the plane is airborne or about to depart.
// "estimated" covers "Estimated dep HH:MM" — the daily cache is frozen after the 02:00 UTC
// cron, so flights that departed later in the day still show "Estimated dep" all day.
// Querying adsb.fi for them is cheap — if they're on the ground it returns nothing.
const ACTIVE_KEYWORDS = ['departed', 'took off', 'en route', 'in flight', 'boarding', 'gate close', 'approaching', 'estimated']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let trackedCache: { map: Record<string, any>; ts: number } | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchTrackedPositions(callsigns: string[]): Promise<Record<string, any>> {
  if (!callsigns.length) return {}
  if (trackedCache && Date.now() - trackedCache.ts < 10_000) return trackedCache.map

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: Record<string, any> = {}
  const BATCH = 3
  for (let i = 0; i < callsigns.length; i += BATCH) {
    if (i > 0) await new Promise(r => setTimeout(r, 300))
    await Promise.all(callsigns.slice(i, i + BATCH).map(async cs => {
      try {
        const res = await fetch(`https://opendata.adsb.fi/api/v2/callsign/${cs}`, {
          headers: { 'User-Agent': 'FlightTracker/1.0' },
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) return
        const json = await res.json()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ac = (json.ac ?? []).find((a: any) => a.lat != null)
        if (ac) results[cs] = ac
      } catch { /* silent */ }
    }))
  }

  trackedCache = { map: results, ts: Date.now() }
  return results
}

// ── Hex-based global lookup from flight_signal_log ────────────────────────────
// Tracks confirmed-airborne flights (real ADS-B, not FR24 cache guess) that have
// left both radii. Calls adsb.fi /api/v2/hex/{hex} — works globally from Vercel.
interface SignalFlight { callsign: string; hex: string; dep_iata: string | null; arr_iata: string | null; flight_date: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let hexCache: { map: Record<string, any>; ts: number } | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchHexPositions(flights: SignalFlight[], skipHexes: Set<string>): Promise<Record<string, any>> {
  const pending = flights.filter(f => f.hex && !skipHexes.has(f.hex.toLowerCase()))
  if (!pending.length) return {}
  if (hexCache && Date.now() - hexCache.ts < 10_000) {
    // Return cached result filtered to current pending set
    const hexSet = new Set(pending.map(f => f.hex.toLowerCase()))
    return Object.fromEntries(Object.entries(hexCache.map).filter(([, a]) => hexSet.has((a.hex ?? '').toLowerCase())))
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: Record<string, any> = {}
  const BATCH = 3
  for (let i = 0; i < pending.length; i += BATCH) {
    if (i > 0) await new Promise(r => setTimeout(r, 300))
    await Promise.all(pending.slice(i, i + BATCH).map(async f => {
      try {
        const res = await fetch(`https://opendata.adsb.fi/api/v2/hex/${f.hex.toLowerCase()}`, {
          headers: { 'User-Agent': 'FlightTracker/1.0' },
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) return
        const json = await res.json()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ac = (json.ac ?? []).find((a: any) => a.lat != null)
        if (ac) results[f.callsign] = { ...ac, _sigFlight: f }
      } catch { /* silent */ }
    }))
  }

  hexCache = { map: results, ts: Date.now() }
  return results
}

// Fetch today's confirmed-airborne flights with hex codes from flight_signal_log
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let signalCache: { flights: SignalFlight[]; ts: number } | null = null
async function fetchSignalFlights(): Promise<SignalFlight[]> {
  if (signalCache && Date.now() - signalCache.ts < 30_000) return signalCache.flights
  const today   = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
  // Only include flights that became airborne within the last 8 hours — covers the longest
  // Syrian route (DAM→AMS ~4.5h). Using airborne_at, not last_seen_at: a flight leaving
  // the Syria radius 20 min after takeoff would have last_seen ~2h ago on a 3h flight,
  // which a tight last_seen cutoff would incorrectly exclude.
  const cutoff  = new Date(Date.now() - 8 * 3_600_000).toISOString()
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/flight_signal_log`
      + `?flight_date=eq.${today}&actual_arr_at=is.null&airborne_at=not.is.null&hex=not.is.null`
      + `&airborne_at=gte.${cutoff}`
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchLastKnownPositions(): Promise<any[]> {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const res = await fetch(
    `${SB_URL}/rest/v1/aircraft_last_seen?seen_at=gte.${cutoff}&order=seen_at.desc&limit=500`,
    { headers: SB_HEADERS },
  )
  if (!res.ok) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await res.json()
  return rows.map(r => ({
    hex:          r.hex,
    flight:       r.callsign ?? '',
    lat:          r.lat,
    lon:          r.lon,
    alt_baro:     r.alt_baro,
    gs:           r.gs,
    track:        r.track,
    t:            r.aircraft_type,
    r:            r.registration,
    board_match:    false,
    dep_iata:       null,
    arr_iata:       null,
    arr_time_utc:   null,
    duration_min:   null,
    iata_number:    null,
    actual_dep_utc: null,
    seen_at:        r.seen_at,
    stale:          true,
  }))
}

function unixToHHMM(unix: number): string {
  const d = new Date(unix * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// ── Radius feed in-flight dedup ───────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let feedCache: { aircraft: any[]; ts: number } | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let feedInflight: Promise<any[]> | null = null

// ── Live ADS-B departure writeback ────────────────────────────────────────────
// writeInboundDep: UAE/Gulf radius sees an inbound flight airborne → write real_dep
//   to the arrival-airport (Syrian) cache row so future polls find it.
// writeOutboundDep: Syria radius sees an outbound flight airborne → write real_dep
//   to the departure-airport (Syrian) cache row so the ghost marker appears once
//   the plane leaves the radius.
// One write per callsign per Vercel instance lifetime (depSynced guard).
const SYRIAN_AIRPORTS_SET = new Set(['DAM', 'ALP', 'LTK'])
const depSynced = new Set<string>()

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

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const iataToIcao    = await fetchIataToIcao()
    const resolvedBoard = await fetchBoardFlights(iataToIcao)

    // callsign → board info
    const boardMap = new Map<string, BoardFlight>()
    for (const f of resolvedBoard) boardMap.set(f.callsign, f)

    // Flights whose status says they're airborne — track globally by callsign.
    // Also include flights confirmed departed by real_dep timestamp but with no
    // arrival yet — these appear in Business API data without a "status" text string.
    const activeCallsigns = resolvedBoard
      .filter(f =>
        ACTIVE_KEYWORDS.some(kw => f.status.includes(kw)) ||
        (f.actual_dep_utc != null && f.actual_arr_utc == null)
      )
      .map(f => f.callsign)

    // Radius feeds (cached 10s, in-flight dedup)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let visualAircraft: any[]
    if (feedCache && Date.now() - feedCache.ts < 10_000) {
      visualAircraft = feedCache.aircraft
    } else {
      if (!feedInflight) {
        feedInflight = Promise.all([
          fetchRadiusFeed(FEEDS_SYRIA),
          fetchRadiusFeed(FEEDS_UAE),
        ]).then(([syria, uae]) => {
          const seenHex = new Set<string>()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const merged: any[] = []
          for (const a of [...syria, ...uae]) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (seenHex.has((a as any).hex)) continue
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            seenHex.add((a as any).hex)
            merged.push(a)
          }
          feedCache = { aircraft: merged, ts: Date.now() }
          feedInflight = null
          return merged
        }).catch(err => { feedInflight = null; throw err })
      }
      visualAircraft = await feedInflight
    }

    // Tracked callsigns + confirmed-airborne hex list fetched in parallel with persist
    const [trackedMap, signalFlights] = await Promise.all([
      fetchTrackedPositions(activeCallsigns),
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
          const depTs    = info.sched_dep ?? Math.floor(Date.now() / 1000)
          actual_dep_utc = new Date(depTs * 1000).toISOString()
          if (!depSynced.has(cs)) {
            depSynced.add(cs)
            writeInboundDep(info, depTs).catch(() => {})
          }
        } else if (info.dep_iata && SYRIAN_AIRPORTS_SET.has(info.dep_iata)
            && !SYRIAN_AIRPORTS_SET.has(info.arr_iata ?? '')) {
          // Outbound
          const depTs    = info.sched_dep ?? Math.floor(Date.now() / 1000)
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
        iata_number:    info?.num            ?? null,
        actual_dep_utc,
        actual_arr_utc: info?.actual_arr_utc ?? null,
        dep_delay_min:  info?.dep_delay_min  ?? null,
        airline_iata:   info?.airline_iata   ?? null,
      })
    }

    // Tracked flights outside both visual radii
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trackedExtra: any[] = []
    for (const [cs, a] of Object.entries(trackedMap)) {
      if (seenHex.has(a.hex)) continue
      seenHex.add(a.hex)
      const info = boardMap.get(cs)

      // Same departure writeback as the visual radius loop — catches outbound ALP/DAM/LTK
      // flights that only become visible to adsb.fi once they cross into Turkish airspace
      // (outside the 700 km Syria radius but returned by the global callsign query).
      let te_actual_dep_utc = info?.actual_dep_utc ?? null
      const teAirborne = (a.alt_baro ?? 0) > 500 && (a.gs ?? 0) > 80
      if (!te_actual_dep_utc && info && teAirborne) {
        if (info.arr_iata && SYRIAN_AIRPORTS_SET.has(info.arr_iata)
            && !SYRIAN_AIRPORTS_SET.has(info.dep_iata ?? '')) {
          // Inbound to Syrian airport
          const depTs = info.sched_dep ?? Math.floor(Date.now() / 1000)
          te_actual_dep_utc = new Date(depTs * 1000).toISOString()
          if (!depSynced.has(cs)) { depSynced.add(cs); writeInboundDep(info, depTs).catch(() => {}) }
        } else if (info.dep_iata && SYRIAN_AIRPORTS_SET.has(info.dep_iata)
            && !SYRIAN_AIRPORTS_SET.has(info.arr_iata ?? '')) {
          // Outbound from Syrian airport
          const depTs = info.sched_dep ?? Math.floor(Date.now() / 1000)
          te_actual_dep_utc = new Date(depTs * 1000).toISOString()
          if (!depSynced.has(cs)) { depSynced.add(cs); writeOutboundDep(info, depTs).catch(() => {}) }
        }
      }

      trackedExtra.push({
        ...a,
        board_match:    !!info,
        dep_iata:       info?.dep_iata       ?? null,
        arr_iata:       info?.arr_iata       ?? null,
        dep_time_utc:   info?.sched_dep      ? unixToHHMM(info.sched_dep) : null,
        arr_time_utc:   info?.sched_arr      ? unixToHHMM(info.sched_arr) : null,
        duration_min:   info?.duration_min   ?? null,
        iata_number:    info?.num            ?? null,
        actual_dep_utc: te_actual_dep_utc,
        actual_arr_utc: info?.actual_arr_utc ?? null,
        dep_delay_min:  info?.dep_delay_min  ?? null,
        airline_iata:   info?.airline_iata   ?? null,
      })
    }
    // Hex-based global lookup for flights confirmed airborne by real ADS-B signal
    // but outside both radii and not found by the callsign tracker.
    const hexMap = await fetchHexPositions(signalFlights, seenHex)
    for (const [cs, a] of Object.entries(hexMap)) {
      const hexLower = (a.hex ?? '').toLowerCase()
      if (seenHex.has(hexLower)) continue
      seenHex.add(hexLower)
      const sig  = a._sigFlight as SignalFlight
      const info = boardMap.get(cs)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _sigFlight: _unused, ...aircraft } = a
      trackedExtra.push({
        ...aircraft,
        flight:         cs,
        board_match:    true,
        dep_iata:       sig.dep_iata,
        arr_iata:       sig.arr_iata,
        dep_time_utc:   info?.sched_dep    ? unixToHHMM(info.sched_dep) : null,
        arr_time_utc:   info?.sched_arr    ? unixToHHMM(info.sched_arr) : null,
        duration_min:   info?.duration_min ?? null,
        iata_number:    info?.num          ?? null,
        actual_dep_utc: info?.actual_dep_utc ?? null,
        actual_arr_utc: info?.actual_arr_utc ?? null,
        dep_delay_min:  info?.dep_delay_min  ?? null,
        airline_iata:   info?.airline_iata   ?? null,
      })
    }

    if (trackedExtra.length) upsertPositions(trackedExtra).catch(() => {})

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
    // For inbound flights without a departure confirmation (FR24 only updates the
    // arrival-airport row, which stays "Estimated" until landing), we synthesize
    // actual_dep_utc from sched_dep so the ESTIMATED ghost marker still appears.
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
          iata_number:     f.num,
          dep_delay_min:   f.dep_delay_min,
          airline_iata:    f.airline_iata,
        }
      })

    return NextResponse.json({
      ok:           true,
      aircraft:     [...annotated, ...trackedExtra],
      boardDeparted,
      ts:           feedCache!.ts,
    })
  } catch (err) {
    if (feedCache?.aircraft.length) {
      return NextResponse.json({ ok: true, aircraft: feedCache.aircraft, ts: feedCache.ts, warn: String(err) })
    }
    try {
      const dbAc = await fetchLastKnownPositions()
      return NextResponse.json({ ok: true, aircraft: dbAc, ts: 0, warn: String(err), from_db: true })
    } catch {
      return NextResponse.json({ ok: false, aircraft: [], warn: String(err) })
    }
  }
}

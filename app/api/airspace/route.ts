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

// Extract actual departure UTC from FR24 status string ("Departed 01:55" → ISO).
// Time in status is Syria local (UTC+3); date is the Syria operating date.
function extractActualDepUtc(status: string, date: string): string | null {
  const t = status.toLowerCase()
  if (!t.includes('departed') && !t.includes('took off')) return null
  const match = status.match(/\b(\d{1,2}):(\d{2})\b/)
  if (!match) return null
  const baseMs = new Date(date + 'T00:00:00Z').getTime()
  return new Date(baseMs + (parseInt(match[1]) * 60 + parseInt(match[2]) - 180) * 60_000).toISOString()
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
  actual_dep_utc: string | null // extracted from "Departed HH:MM" in status
}

let boardCache: { flights: BoardFlight[]; date: string; ts: number } | null = null

async function fetchBoardFlights(iataToIcao: Record<string, string>): Promise<BoardFlight[]> {
  const date = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
  if (boardCache && boardCache.date === date && Date.now() - boardCache.ts < 60_000)
    return boardCache.flights

  const res = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${date}&select=airport_iata,departures,arrivals`,
    { headers: SB_HEADERS },
  )
  if (!res.ok) return boardCache?.flights ?? []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await res.json()

  const seen    = new Set<string>()
  const flights: BoardFlight[] = []

  for (const row of rows) {
    const ap = (row.airport_iata as string) || ''
    for (const section of ['departures', 'arrivals'] as const) {
      for (const f of (row[section] ?? [])) {
        const num = (f.num ?? '').toString()
        if (!num) continue
        const key = `${num}|${f.sched_dep ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        const status = (f.status ?? '').toLowerCase()
        // FR24 cache omits the implicit airport — fill dep_iata for departures
        // and arr_iata for arrivals from the row's airport_iata.
        flights.push({
          num,
          callsign:       toCallsign(num, iataToIcao),
          dep_iata:       f.dep_iata || (section === 'departures' ? ap : null) || null,
          arr_iata:       f.arr_iata || (section === 'arrivals'   ? ap : null) || null,
          sched_dep:      f.sched_dep    ?? null,
          sched_arr:      f.sched_arr    ?? null,
          duration_min:   f.duration_min ?? null,
          status,
          actual_dep_utc: extractActualDepUtc(status, date),
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
  const BATCH = 8
  for (let i = 0; i < callsigns.length; i += BATCH) {
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

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const iataToIcao    = await fetchIataToIcao()
    const resolvedBoard = await fetchBoardFlights(iataToIcao)

    // callsign → board info
    const boardMap = new Map<string, BoardFlight>()
    for (const f of resolvedBoard) boardMap.set(f.callsign, f)

    // Flights whose status says they're airborne — track globally by callsign
    const activeCallsigns = resolvedBoard
      .filter(f => ACTIVE_KEYWORDS.some(kw => f.status.includes(kw)))
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

    // Tracked callsigns fetched in parallel with persist
    const [trackedMap] = await Promise.all([
      fetchTrackedPositions(activeCallsigns),
      upsertPositions(visualAircraft),
    ])

    // Annotate visual radius aircraft
    const seenHex = new Set<string>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotated: any[] = []
    for (const a of visualAircraft) {
      seenHex.add(a.hex)
      const cs   = (a.flight ?? '').trim().toUpperCase()
      const info = boardMap.get(cs)
      annotated.push({
        ...a,
        board_match:    !!info,
        dep_iata:       info?.dep_iata      ?? null,
        arr_iata:       info?.arr_iata      ?? null,
        arr_time_utc:   info?.sched_arr     != null ? unixToHHMM(info.sched_arr) : null,
        duration_min:   info?.duration_min  ?? null,
        iata_number:    info?.num           ?? null,
        actual_dep_utc: info?.actual_dep_utc ?? null,
      })
    }

    // Tracked flights outside both visual radii
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trackedExtra: any[] = []
    for (const [cs, a] of Object.entries(trackedMap)) {
      if (seenHex.has(a.hex)) continue
      seenHex.add(a.hex)
      const info = boardMap.get(cs)
      trackedExtra.push({
        ...a,
        board_match:    true,
        dep_iata:       info?.dep_iata      ?? null,
        arr_iata:       info?.arr_iata      ?? null,
        arr_time_utc:   info?.sched_arr     != null ? unixToHHMM(info.sched_arr) : null,
        duration_min:   info?.duration_min  ?? null,
        iata_number:    info?.num           ?? null,
        actual_dep_utc: info?.actual_dep_utc ?? null,
      })
    }
    if (trackedExtra.length) upsertPositions(trackedExtra).catch(() => {})

    return NextResponse.json({
      ok:       true,
      aircraft: [...annotated, ...trackedExtra],
      ts:       feedCache!.ts,
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

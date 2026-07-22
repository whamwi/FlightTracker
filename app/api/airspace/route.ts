import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const FEEDS = [
  'https://opendata.adsb.fi/api/v2/lat/33.0/lon/42.0/dist/900',
  'https://api.adsb.lol/v2/lat/33.0/lon/42.0/dist/900',
]

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_ANON_KEY!
const FR24_KEY = process.env.FR24_API_KEY ?? ''

// ── ADS-B feed cache (10s) ───────────────────────────────────────────────────
let feedCache: { aircraft: unknown[]; ts: number } | null = null
let feedInflight: Promise<unknown[]> | null = null

async function fetchFeed(): Promise<unknown[]> {
  for (const url of FEEDS) {
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
  throw new Error('all feeds failed')
}

// ── Syria callsign → schedule info cache (1h) ────────────────────────────────
interface SyriaInfo { airports: string[]; arr_time_utc: string | null; duration_min: number | null; dep_syria: boolean; arr_syria: boolean }
type SyriaMap = Map<string, SyriaInfo>

// ── Actual departure times from flight_status (2-min cache) ──────────────────
let actualDepsCache: { map: Map<string, string>; ts: number } | null = null

async function fetchActualDeps(): Promise<Map<string, string>> {
  if (actualDepsCache && Date.now() - actualDepsCache.ts < 2 * 60_000)
    return actualDepsCache.map

  const syriaDate = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
  const res = await fetch(
    `${SB_URL}/rest/v1/flight_status?select=callsign,actual_dep_utc&operating_date=eq.${syriaDate}&actual_dep_utc=not.is.null`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  ).catch(() => null)

  const map = new Map<string, string>()
  if (res?.ok) {
    const rows: { callsign: string; actual_dep_utc: string }[] = await res.json()
    for (const r of rows) {
      if (r.callsign && r.actual_dep_utc) {
        map.set(r.callsign, new Date(r.actual_dep_utc).toISOString().slice(11, 16))
      }
    }
  }
  actualDepsCache = { map, ts: Date.now() }
  return map
}

let syriaCache: { map: SyriaMap; ts: number } | null = null

async function fetchSyriaMap(): Promise<SyriaMap> {
  if (syriaCache && Date.now() - syriaCache.ts < 3_600_000)
    return syriaCache.map

  const res = await fetch(`${SB_URL}/rest/v1/rpc/get_syria_callsigns`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  if (!res.ok) return syriaCache?.map ?? new Map()

  const rows: { broadcast_callsign: string; syria_airports: string[]; arr_time_utc: string | null; duration_min: number | null; dep_syria: boolean; arr_syria: boolean }[] = await res.json()
  const callsignMap: SyriaMap = new Map(rows.map(r => [
    r.broadcast_callsign,
    { airports: r.syria_airports, arr_time_utc: r.arr_time_utc, duration_min: r.duration_min, dep_syria: r.dep_syria ?? false, arr_syria: r.arr_syria ?? false },
  ]))
  syriaCache = { map: callsignMap, ts: Date.now() }
  return callsignMap
}

// ── Persist last known positions to Supabase ─────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertPositions(aircraft: any[]): Promise<void> {
  if (aircraft.length === 0) return
  const now = new Date().toISOString()
  const rows = aircraft.map(a => ({
    hex:           a.hex,
    callsign:      (a.flight ?? '').trim() || null,
    lat:           a.lat,
    lon:           a.lon,
    alt_baro:      typeof a.alt_baro === 'number' ? a.alt_baro : null,
    gs:            a.gs ?? null,
    track:         a.track ?? null,
    aircraft_type: a.t ?? null,
    registration:  a.r ?? null,
    syria_airports: a.syria_airports ?? [],
    seen_at:        now,
    // First-seen fields: preserved by DB trigger on subsequent updates
    first_seen_at:  now,
    first_lat:      a.lat,
    first_lon:      a.lon,
    first_alt:      typeof a.alt_baro === 'number' ? a.alt_baro : null,
  }))

  // Batch in 200-row chunks
  for (let i = 0; i < rows.length; i += 200) {
    await fetch(`${SB_URL}/rest/v1/aircraft_last_seen`, {
      method: 'POST',
      headers: {
        apikey:        SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer:        'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows.slice(i, i + 200)),
    }).catch(() => {})
  }
}

// ── Fetch last known positions from Supabase (full feed-down fallback) ───────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchLastKnownPositions(): Promise<any[]> {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const res = await fetch(
    `${SB_URL}/rest/v1/aircraft_last_seen?seen_at=gte.${cutoff}&order=seen_at.desc`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  )
  if (!res.ok) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await res.json()
  return rows.map(r => ({
    hex:           r.hex,
    flight:        r.callsign ?? '',
    lat:           r.lat,
    lon:           r.lon,
    alt_baro:      r.alt_baro,
    gs:            r.gs,
    track:         r.track,
    t:             r.aircraft_type,
    r:             r.registration,
    syria_airports: r.syria_airports ?? [],
    seen_at:       r.seen_at,
  }))
}

// ── FR24 live enrichment for callsigns missed by free feeds (5-min cache) ────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fr24Cache: { aircraft: any[]; ts: number } | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchFR24Missing(callsigns: string[]): Promise<any[]> {
  if (!FR24_KEY || callsigns.length === 0) return []
  if (fr24Cache && Date.now() - fr24Cache.ts < 5 * 60_000) return fr24Cache.aircraft

  try {
    const res = await fetch(
      `https://fr24api.flightradar24.com/api/live/flight-positions/full?callsigns=${callsigns.join(',')}`,
      {
        headers: {
          Accept: 'application/json',
          'Accept-Version': 'v1',
          Authorization: `Bearer ${FR24_KEY}`,
        },
        signal: AbortSignal.timeout(8000),
      },
    )
    if (!res.ok) { fr24Cache = { aircraft: [], ts: Date.now() }; return [] }
    const json = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aircraft = (json.data ?? []).map((a: any) => ({
      hex:      a.hex,
      flight:   (a.callsign ?? a.flight ?? '').trim(),
      lat:      a.lat,
      lon:      a.lon,
      alt_baro: a.alt,
      gs:       a.gspeed,
      track:    a.track,
      t:        a.type,
      r:        a.reg,
      fr24:     true,
    }))
    fr24Cache = { aircraft, ts: Date.now() }
    return aircraft
  } catch {
    fr24Cache = { aircraft: [], ts: Date.now() }
    return []
  }
}

// ── Syria stale positions — always appended alongside live feed (30s cache) ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let syriaPosCache: { rows: any[]; ts: number } | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchSyriaStale(excludeHexes: Set<string>, syriaMap: SyriaMap): Promise<any[]> {
  if (!syriaPosCache || Date.now() - syriaPosCache.ts > 30_000) {
    const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    const res = await fetch(
      `${SB_URL}/rest/v1/aircraft_last_seen?syria_airports=ov.{DAM,ALP}&seen_at=gte.${cutoff}&order=seen_at.desc`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
    ).catch(() => null)
    if (res?.ok) syriaPosCache = { rows: await res.json(), ts: Date.now() }
  }
  if (!syriaPosCache?.rows.length) return []

  return syriaPosCache.rows
    .filter(r => !excludeHexes.has(r.hex))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any) => {
      const callsign = r.callsign ?? ''
      const info     = syriaMap.get(callsign)
      return {
        hex:           r.hex,
        flight:        callsign,
        lat:           r.lat,
        lon:           r.lon,
        alt_baro:      r.alt_baro,
        gs:            r.gs,
        track:         r.track,
        t:             r.aircraft_type,
        r:             r.registration,
        syria_airports: r.syria_airports ?? [],
        arr_time_utc:  info?.arr_time_utc  ?? null,
        duration_min:  info?.duration_min  ?? null,
        dep_syria:     info?.dep_syria     ?? false,
        arr_syria:     info?.arr_syria     ?? false,
        seen_at:       r.seen_at,
        stale:         true,
      }
    })
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const [aircraft, syriaMap, actualDeps] = await Promise.all([
      (async () => {
        if (feedCache && Date.now() - feedCache.ts < 10_000) return feedCache.aircraft
        if (!feedInflight) {
          feedInflight = fetchFeed()
            .then(ac => { feedCache = { aircraft: ac, ts: Date.now() }; return ac })
            .finally(() => { feedInflight = null })
        }
        return feedInflight
      })(),
      fetchSyriaMap(),
      fetchActualDeps(),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotated = (aircraft as any[]).map(a => {
      const callsign = (a.flight ?? '').trim()
      const info     = syriaMap.get(callsign)
      return {
        ...a,
        syria_airports: info?.airports    ?? [],
        arr_time_utc:   info?.arr_time_utc ?? null,
        duration_min:   info?.duration_min ?? null,
        dep_syria:      info?.dep_syria    ?? false,
        arr_syria:      info?.arr_syria    ?? false,
      }
    })

    // Callsigns already visible in the free ADS-B feeds
    const liveCallsigns = new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (aircraft as any[]).map(a => (a.flight ?? '').trim()).filter(Boolean)
    )

    // Syria callsigns scheduled today that the free feeds didn't pick up
    const nowSec = (() => { const d = new Date(); return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 })()
    const missingCallsigns = [...syriaMap.keys()].filter(cs => {
      if (liveCallsigns.has(cs)) return false
      const info = syriaMap.get(cs)!
      if (!info.arr_time_utc) return true

      // Use actual departure time (from ADB webhook via flight_status) when available;
      // fall back to scheduled departure = arr_time_utc - duration_min.
      const actualDep = actualDeps.get(cs)
      let depSec: number
      if (actualDep) {
        const [dh, dm] = actualDep.split(':').map(Number)
        depSec = dh * 3600 + dm * 60
      } else {
        const [ah, am] = info.arr_time_utc.split(':').map(Number)
        depSec = ah * 3600 + am * 60 - (info.duration_min ?? 180) * 60
      }

      // Estimated arrival = actual (or scheduled) dep + duration; window closes 90min after that.
      const estArrSec = depSec + (info.duration_min ?? 180) * 60
      const start     = ((depSec    - 30 * 60) + 86400) % 86400
      const end       = ((estArrSec + 90 * 60) + 86400) % 86400
      return start < end ? nowSec >= start && nowSec <= end : nowSec >= start || nowSec <= end
    })

    // Persist live positions + fetch FR24 enrichment in parallel
    const liveSyriaHexes = new Set(
      annotated.filter(a => a.syria_airports.length > 0).map(a => a.hex)
    )
    const [, fr24Raw] = await Promise.all([
      upsertPositions(annotated),
      fetchFR24Missing(missingCallsigns),
    ])

    // Annotate FR24 aircraft with Syria info and persist them.
    // Exclude any callsign the free feed already covers — FR24 is a fallback only.
    // The 5-min FR24 cache can hold a callsign that just became visible in the free
    // feed; without this filter both sources would appear in the same response.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fr24Annotated = fr24Raw
      .filter((a: any) => !liveCallsigns.has((a.flight ?? '').trim()))
      .map((a: any) => {
        const info = syriaMap.get(a.flight)
        return { ...a, syria_airports: info?.airports ?? [], arr_time_utc: info?.arr_time_utc ?? null, duration_min: info?.duration_min ?? null, dep_syria: info?.dep_syria ?? false, arr_syria: info?.arr_syria ?? false }
      })
    if (fr24Annotated.length > 0) upsertPositions(fr24Annotated).catch(() => {})

    // Exclude both live ADS-B and FR24 hexes from stale so there are no duplicates
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fr24Hexes = new Set(fr24Raw.map((a: any) => a.hex))
    const excludeHexes = new Set([...liveSyriaHexes, ...fr24Hexes])
    const syriaStale = await fetchSyriaStale(excludeHexes, syriaMap)

    const fr24Callsigns = fr24Annotated.map((a: any) => (a.flight ?? '').trim()).filter(Boolean)
    return NextResponse.json({ ok: true, aircraft: [...annotated, ...syriaStale, ...fr24Annotated], ts: feedCache!.ts, fr24Ts: fr24Cache?.ts ?? 0, fr24Callsigns })
  } catch (err) {
    // In-memory cache fallback
    if (feedCache?.aircraft && feedCache.aircraft.length > 0) {
      return NextResponse.json({ ok: true, aircraft: feedCache.aircraft, ts: feedCache.ts, warn: String(err) })
    }
    // DB fallback — show last known positions from Supabase
    try {
      const dbPositions = await fetchLastKnownPositions()
      return NextResponse.json({
        ok: true, aircraft: dbPositions, ts: 0,
        warn: String(err), from_db: true,
      })
    } catch {
      return NextResponse.json({ ok: false, aircraft: [], warn: String(err) })
    }
  }
}

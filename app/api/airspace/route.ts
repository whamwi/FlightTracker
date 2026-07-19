import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const FEEDS = [
  'https://opendata.adsb.fi/api/v2/lat/33.0/lon/42.0/dist/900',
  'https://api.adsb.lol/v2/lat/33.0/lon/42.0/dist/900',
]

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

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

// ── Syria airport proximity fallback ─────────────────────────────────────────
const SYRIA_AP_COORDS: [number, number, string][] = [
  [33.4114, 36.5156, 'DAM'],
  [36.1807, 37.2244, 'ALP'],
]

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R    = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── Syria callsign → schedule info cache (1h) ────────────────────────────────
interface SyriaInfo { airports: string[]; arr_time_utc: string | null; duration_min: number | null }
type SyriaMap = Map<string, SyriaInfo>

let syriaCache: { map: SyriaMap; ts: number } | null = null

async function fetchSyriaMap(): Promise<SyriaMap> {
  if (syriaCache && Date.now() - syriaCache.ts < 3_600_000) return syriaCache.map

  const res = await fetch(`${SB_URL}/rest/v1/rpc/get_syria_callsigns`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })

  if (!res.ok) return syriaCache?.map ?? new Map()

  const rows: { broadcast_callsign: string; syria_airports: string[]; arr_time_utc: string | null; duration_min: number | null }[] = await res.json()
  const callsignMap: SyriaMap = new Map(rows.map(r => [
    r.broadcast_callsign,
    { airports: r.syria_airports, arr_time_utc: r.arr_time_utc, duration_min: r.duration_min },
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
    seen_at:       now,
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
        seen_at:       r.seen_at,
        stale:         true,
      }
    })
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const [aircraft, syriaMap] = await Promise.all([
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
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotated = (aircraft as any[]).map(a => {
      const callsign = (a.flight ?? '').trim()
      const info     = syriaMap.get(callsign)
      let syriaAirports: string[] = info?.airports ?? []

      // Proximity fallback: tag planes within 150 km of DAM/ALP that are below
      // 20 000 ft (not cruising over Syria on an unrelated route)
      if (syriaAirports.length === 0 && a.lat != null && a.lon != null) {
        const altFt = typeof a.alt_baro === 'number' ? a.alt_baro : null
        if (altFt === null || altFt < 20000) {
          for (const [apLat, apLon, iata] of SYRIA_AP_COORDS) {
            if (haversineKm(a.lat, a.lon, apLat, apLon) < 150) {
              syriaAirports = [iata]
              break
            }
          }
        }
      }

      return {
        ...a,
        syria_airports:  syriaAirports,
        arr_time_utc:    info?.arr_time_utc  ?? null,
        duration_min:    info?.duration_min  ?? null,
      }
    })

    // Persist live positions, then append stale Syria positions not in live feed
    const liveSyriaHexes = new Set(
      annotated.filter(a => a.syria_airports.length > 0).map(a => a.hex)
    )
    const [, syriaStale] = await Promise.all([
      upsertPositions(annotated),
      fetchSyriaStale(liveSyriaHexes, syriaMap),
    ])

    return NextResponse.json({ ok: true, aircraft: [...annotated, ...syriaStale], ts: feedCache!.ts })
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

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

// ── Syria callsign → airports map cache (1h) ─────────────────────────────────
let syriaCache: { map: Map<string, string[]>; ts: number } | null = null

async function fetchSyriaMap(): Promise<Map<string, string[]>> {
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

  const rows: { broadcast_callsign: string; syria_airports: string[] }[] = await res.json()
  const callsignMap = new Map(rows.map(r => [r.broadcast_callsign, r.syria_airports]))
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

// ── Fetch last known positions from Supabase (DB fallback) ───────────────────
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
      const callsign    = (a.flight ?? '').trim()
      const syriaAirports = syriaMap.get(callsign) ?? []
      return { ...a, syria_airports: syriaAirports }
    })

    // Persist to Supabase (awaited so function doesn't exit before completion)
    await upsertPositions(annotated)

    return NextResponse.json({ ok: true, aircraft: annotated, ts: feedCache!.ts })
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

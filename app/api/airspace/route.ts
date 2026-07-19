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
// Maps broadcast_callsign → array of Syria airport IATA codes it serves
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

  if (!res.ok) {
    // Return stale cache if available, otherwise empty
    return syriaCache?.map ?? new Map()
  }

  const rows: { broadcast_callsign: string; syria_airports: string[] }[] = await res.json()
  const callsignMap = new Map(rows.map(r => [r.broadcast_callsign, r.syria_airports]))

  syriaCache = { map: callsignMap, ts: Date.now() }
  return callsignMap
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
      const syriaAirports = syriaMap.get(callsign) ?? []
      return { ...a, syria_airports: syriaAirports }
    })

    return NextResponse.json({ ok: true, aircraft: annotated, ts: feedCache!.ts, syria_callsigns: syriaMap.size })
  } catch (err) {
    const fallback = feedCache?.aircraft ?? []
    return NextResponse.json({ ok: true, aircraft: fallback, ts: feedCache?.ts ?? 0, warn: String(err) })
  }
}

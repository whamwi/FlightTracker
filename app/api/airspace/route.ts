import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Centre of IST→DXB corridor; 900 nm radius covers both endpoints
const FEEDS = [
  'https://opendata.adsb.fi/api/v2/lat/33.0/lon/42.0/dist/900',
  'https://api.adsb.lol/v2/lat/33.0/lon/42.0/dist/900',
]

let cache: { aircraft: unknown[]; ts: number } | null = null
let inflight: Promise<unknown[]> | null = null

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

export async function GET() {
  try {
    if (cache && Date.now() - cache.ts < 10_000) {
      return NextResponse.json({ ok: true, aircraft: cache.aircraft, ts: cache.ts })
    }
    if (!inflight) {
      inflight = fetchFeed()
        .then(aircraft => { cache = { aircraft, ts: Date.now() }; return aircraft })
        .finally(() => { inflight = null })
    }
    const aircraft = await inflight
    return NextResponse.json({ ok: true, aircraft, ts: cache!.ts })
  } catch (err) {
    const fallback = cache?.aircraft ?? []
    return NextResponse.json({ ok: true, aircraft: fallback, ts: cache?.ts ?? 0, warn: String(err) })
  }
}

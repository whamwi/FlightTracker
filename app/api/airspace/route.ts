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

// ── Syria-connected callsigns cache (1h) ─────────────────────────────────────
let syriaCache: { callsigns: Set<string>; ts: number } | null = null

async function fetchSyriaCallsigns(): Promise<Set<string>> {
  if (syriaCache && Date.now() - syriaCache.ts < 3_600_000) return syriaCache.callsigns

  try {
    // Step 1: flight_ids that touch DAM or ALP
    const schedRes = await fetch(
      `${SB_URL}/rest/v1/flight_schedule?select=flight_id&or=(dep_iata.in.(DAM,ALP),arr_iata.in.(ALP,DAM))`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    )
    const schedRows: { flight_id: number }[] = await schedRes.json()
    const ids = [...new Set(schedRows.map(r => r.flight_id))]
    if (ids.length === 0) return new Set()

    // Step 2: their broadcast_callsigns
    const lookupRes = await fetch(
      `${SB_URL}/rest/v1/flight_lookup?select=broadcast_callsign&id=in.(${ids.join(',')})&broadcast_callsign=not.is.null`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    )
    const lookupRows: { broadcast_callsign: string }[] = await lookupRes.json()
    const callsigns = new Set(lookupRows.map(r => r.broadcast_callsign))

    syriaCache = { callsigns, ts: Date.now() }
    return callsigns
  } catch {
    return syriaCache?.callsigns ?? new Set()
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const [aircraft, syriaCallsigns] = await Promise.all([
      (async () => {
        if (feedCache && Date.now() - feedCache.ts < 10_000) return feedCache.aircraft
        if (!feedInflight) {
          feedInflight = fetchFeed()
            .then(ac => { feedCache = { aircraft: ac, ts: Date.now() }; return ac })
            .finally(() => { feedInflight = null })
        }
        return feedInflight
      })(),
      fetchSyriaCallsigns(),
    ])

    // Annotate each aircraft with syria flag
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotated = (aircraft as any[]).map(a => ({
      ...a,
      syria: syriaCallsigns.has((a.flight ?? '').trim()),
    }))

    return NextResponse.json({ ok: true, aircraft: annotated, ts: feedCache!.ts })
  } catch (err) {
    const fallback = feedCache?.aircraft ?? []
    return NextResponse.json({ ok: true, aircraft: fallback, ts: feedCache?.ts ?? 0, warn: String(err) })
  }
}

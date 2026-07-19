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

  try {
    // Get flight_ids + which Syria airports they touch
    const schedRes = await fetch(
      `${SB_URL}/rest/v1/flight_schedule?select=flight_id,dep_iata,arr_iata&or=(dep_iata.in.(DAM,ALP),arr_iata.in.(DAM,ALP))`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    )
    const schedRows: { flight_id: number; dep_iata: string; arr_iata: string }[] = await schedRes.json()

    // Build flight_id → Syria airports
    const idToAirports = new Map<number, Set<string>>()
    for (const row of schedRows) {
      if (!idToAirports.has(row.flight_id)) idToAirports.set(row.flight_id, new Set())
      const airports = idToAirports.get(row.flight_id)!
      if (row.dep_iata === 'DAM' || row.dep_iata === 'ALP') airports.add(row.dep_iata)
      if (row.arr_iata === 'DAM' || row.arr_iata === 'ALP') airports.add(row.arr_iata)
    }

    const ids = [...idToAirports.keys()]
    if (ids.length === 0) return new Map()

    // Resolve flight_ids → broadcast_callsigns
    const lookupRes = await fetch(
      `${SB_URL}/rest/v1/flight_lookup?select=id,broadcast_callsign&id=in.(${ids.join(',')})&broadcast_callsign=not.is.null`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    )
    const lookupRows: { id: number; broadcast_callsign: string }[] = await lookupRes.json()

    const callsignMap = new Map<string, string[]>()
    for (const row of lookupRows) {
      const airports = idToAirports.get(row.id)
      if (airports) callsignMap.set(row.broadcast_callsign, [...airports])
    }

    syriaCache = { map: callsignMap, ts: Date.now() }
    return callsignMap
  } catch {
    return syriaCache?.map ?? new Map()
  }
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

    return NextResponse.json({ ok: true, aircraft: annotated, ts: feedCache!.ts })
  } catch (err) {
    const fallback = feedCache?.aircraft ?? []
    return NextResponse.json({ ok: true, aircraft: fallback, ts: feedCache?.ts ?? 0, warn: String(err) })
  }
}

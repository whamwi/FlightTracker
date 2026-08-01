import { NextResponse } from 'next/server'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

export async function GET() {
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)

  // 1. Fetch flights airborne in the last 6h — airborne_at cutoff (not last_seen_at)
  const cutoff  = new Date(Date.now() - 6 * 3_600_000).toISOString()
  const sigRes = await fetch(
    `${SB_URL}/rest/v1/flight_signal_log`
    + `?flight_date=eq.${today}&actual_arr_at=is.null&airborne_at=not.is.null&hex=not.is.null`
    + `&airborne_at=gte.${cutoff}`
    + `&select=callsign,hex,dep_iata,arr_iata,airborne_at,last_seen_at`,
    { headers: HEADERS }
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flights: any[] = sigRes.ok ? await sigRes.json() : []

  // 2. Test adsb.fi hex lookup sequentially to avoid 429 rate limiting
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: any[] = []
  for (const f of flights) {
    if (results.length > 0) await new Promise(r => setTimeout(r, 300))
    const hex = (f.hex as string).toLowerCase()
    let status = 'not_tried'
    let found  = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ac: any = null
    try {
      const r = await fetch(`https://opendata.adsb.fi/api/v2/hex/${hex}`, {
        headers: { 'User-Agent': 'FlightTracker/1.0' },
        signal: AbortSignal.timeout(5000),
      })
      status = `HTTP ${r.status}`
      if (r.ok) {
        const json = await r.json()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ac = (json.ac ?? []).find((a: any) => a.lat != null) ?? null
        found = !!ac
      }
    } catch (e) {
      status = `ERROR: ${e}`
    }
    results.push({
      callsign:    f.callsign,
      hex,
      route:       `${f.dep_iata}→${f.arr_iata}`,
      airborne_at: f.airborne_at,
      last_seen:   f.last_seen_at,
      adsbfi:      status,
      found,
      lat:         ac?.lat ?? null,
      lon:         ac?.lon ?? null,
      alt_ft:      ac?.alt_baro ?? null,
      gs_kts:      ac?.gs ?? null,
    })
  }

  const found    = results.filter(r => r.found)
  const notFound = results.filter(r => !r.found)

  return NextResponse.json({ today, total: flights.length, found: found.length, results: { found, not_found: notFound } })
}

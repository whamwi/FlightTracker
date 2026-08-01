import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

// 30-second server-side cache to avoid DB hammering when multiple tabs are open
let cache: { flights: object[]; ts: number } | null = null
const CACHE_TTL = 30_000

export async function GET() {
  const now = Date.now()
  if (cache && now - cache.ts < CACHE_TTL) {
    return NextResponse.json({ flights: cache.flights })
  }

  const today = new Date().toISOString().slice(0, 10)
  const res = await fetch(
    `${SB_URL}/rest/v1/flight_signal_log`
    + `?flight_date=eq.${today}&actual_arr_at=is.null&hex=not.is.null`
    + `&select=callsign,hex,dep_iata,arr_iata,flight_date`,
    { headers: HEADERS }
  )

  const flights = res.ok ? await res.json() : []
  cache = { flights, ts: now }
  return NextResponse.json({ flights })
}

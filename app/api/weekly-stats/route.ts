import { NextResponse } from 'next/server'
import { SYRIA_AIRPORT_SET } from '@/lib/syria-airports'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const SYRIAN = SYRIA_AIRPORT_SET

const PREFIX_TO_IATA: Record<string, string> = { FYC: 'XH', SYR: 'RB', HST: 'RB', SXS: 'XQ' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flightAirlineIata(f: any): string {
  if (f.airline_iata) return f.airline_iata
  const num = (f.num ?? '').replace(/\s/g, '')
  return PREFIX_TO_IATA[num.slice(0, 3)] || num.slice(0, 2)
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const airport = searchParams.get('airport')
  if (!airport || !SYRIAN.has(airport)) {
    return NextResponse.json({ ok: false, error: 'airport required (DAM|ALP|LTK)' }, { status: 400 })
  }

  const days = Math.min(30, Math.max(1, parseInt(searchParams.get('days') ?? '7')))

  const todayMs = Date.now()
  const toDate   = new Date(todayMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Damascus' })
  const fromDate = new Date(todayMs - (days - 1) * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Damascus' })

  /*
   * `flight`, not fr24_daily_cache.
   *
   * One row per leg with both ends named, so the two JSONB arrays collapse into a single query
   * and the direction is read off the leg rather than off which array it sat in.
   *
   * The airline allow-list goes with the cache: fr24_daily_cache held whatever FR24 returned,
   * including carriers we do not recognise, so this endpoint had to re-filter. The trigger that
   * builds `flight` already refuses a leg whose airline is not in the table — the codeshare
   * filter agreed on 11 Aug — so anything present here has passed it once already.
   */
  const res = await fetch(
    `${SB_URL}/rest/v1/flight?flight_date=gte.${fromDate}&flight_date=lte.${toDate}`
      + `&or=(dep_iata.eq.${airport},arr_iata.eq.${airport})`
      + `&select=dep_iata,arr_iata,outcome`,
    { headers: HEADERS, next: { revalidate: 3600 } },
  )
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `flight fetch failed: ${res.status}` }, { status: 502 })
  }

  const rows: { dep_iata: string | null; arr_iata: string | null; outcome: string | null }[] =
    await res.json()

  const arrMap: Record<string, number> = {}
  const depMap: Record<string, number> = {}

  for (const r of rows) {
    // A flight that never operated is not a destination served.
    if (r.outcome === 'cancelled') continue
    const dep = r.dep_iata ?? '', arr = r.arr_iata ?? ''
    // Domestic legs count as neither: both ends are Syrian, so there is no destination to name.
    if (arr === airport && dep && !SYRIAN.has(dep)) arrMap[dep] = (arrMap[dep] ?? 0) + 1
    if (dep === airport && arr && !SYRIAN.has(arr)) depMap[arr] = (depMap[arr] ?? 0) + 1
  }

  const ranked = (m: Record<string, number>) =>
    Object.entries(m)
      .map(([iata, count]) => ({ iata, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25)

  return NextResponse.json({
    ok: true,
    from: fromDate,
    to: toDate,
    days,
    arrivals: ranked(arrMap),
    departures: ranked(depMap),
  })
}

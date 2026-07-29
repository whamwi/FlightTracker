import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const SYRIAN = new Set(['DAM', 'ALP', 'LTK'])

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

  const res = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=gte.${fromDate}&flight_date=lte.${toDate}&airport_iata=eq.${airport}&select=arrivals,departures`,
    { headers: HEADERS, next: { revalidate: 3600 } }
  )
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `cache fetch failed: ${res.status}` }, { status: 502 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: { arrivals: any[]; departures: any[] }[] = await res.json()

  const arrMap: Record<string, number> = {}
  const depMap: Record<string, number> = {}

  for (const row of rows) {
    for (const f of (row.arrivals ?? [])) {
      const iata = f.dep_iata
      if (!iata || SYRIAN.has(iata)) continue
      if ((f.status ?? '').toLowerCase().includes('cancel')) continue
      arrMap[iata] = (arrMap[iata] ?? 0) + 1
    }
    for (const f of (row.departures ?? [])) {
      const iata = f.arr_iata
      if (!iata || SYRIAN.has(iata)) continue
      if ((f.status ?? '').toLowerCase().includes('cancel')) continue
      depMap[iata] = (depMap[iata] ?? 0) + 1
    }
  }

  const ranked = (m: Record<string, number>) =>
    Object.entries(m)
      .map(([iata, count]) => ({ iata, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

  return NextResponse.json({
    ok: true,
    from: fromDate,
    to: toDate,
    days,
    arrivals: ranked(arrMap),
    departures: ranked(depMap),
  })
}

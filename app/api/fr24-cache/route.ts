import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

export async function POST(req: Request) {
  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const { airport_iata, flight_date, arrivals, departures } = body as {
    airport_iata: string
    flight_date:  string
    arrivals:     object[]
    departures:   object[]
  }

  if (!airport_iata || !flight_date || !Array.isArray(arrivals) || !Array.isArray(departures)) {
    return NextResponse.json({ ok: false, error: 'Missing fields' }, { status: 400 })
  }

  const res = await fetch(`${SB_URL}/rest/v1/fr24_daily_cache`, {
    method:  'POST',
    headers: {
      apikey:         SB_KEY,
      Authorization:  `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      airport_iata,
      flight_date,
      arrivals,
      departures,
      arr_count:  arrivals.length,
      dep_count:  departures.length,
      fetched_at: new Date().toISOString(),
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ ok: false, error: err }, { status: 502 })
  }

  return NextResponse.json({ ok: true, airport: airport_iata, date: flight_date, arr: arrivals.length, dep: departures.length })
}

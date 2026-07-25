import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

const DAM_SOURCES: Record<string, { url: string; key: string }> = {
  DAM: {
    url: 'https://ognrupehzbbckimkaikb.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nbnJ1cGVoemJiY2tpbWthaWtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ2ODc3NTIsImV4cCI6MjA4MDI2Mzc1Mn0.cBh06V2W7ocx8etUixo2lcdl1XH5RR4pTjXNOG59Xsg',
  },
  ALP: {
    url: 'https://ttqpvffxbouowufwbfze.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0cXB2ZmZ4Ym91b3d1ZndiZnplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY3ODU3NDMsImV4cCI6MjA4MjM2MTc0M30.A3j9iny8RusFtUt8J5mAyaj33cKEQJW9EPJw8iLtVWc',
  },
}

export async function POST(req: Request) {
  const { airport, date } = await req.json()
  const src = DAM_SOURCES[airport]
  if (!src || !date) {
    return NextResponse.json({ ok: false, error: 'airport and date required' }, { status: 400 })
  }

  const srcRes = await fetch(`${src.url}/rest/v1/flight_cache?id=eq.main&select=payload`, {
    headers: { apikey: src.key, Authorization: `Bearer ${src.key}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!srcRes.ok) {
    return NextResponse.json({ ok: false, error: `source ${srcRes.status}` }, { status: 502 })
  }

  const data = await srcRes.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = (data[0]?.payload ?? []).filter((f: any) => f.flightDate === date)

  const arrivals   = all.filter(f => f.type === 'arrival')
  const departures = all.filter(f => f.type === 'departure')

  // Store under a virtual airport key so the flightboard can read it from the same table
  const writeRes = await fetch(`${SB_URL}/rest/v1/fr24_daily_cache`, {
    method: 'POST',
    headers: {
      apikey:         SB_KEY,
      Authorization:  `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      airport_iata: `${airport}_LIVE`,
      flight_date:  date,
      arrivals,
      departures,
      arr_count:    arrivals.length,
      dep_count:    departures.length,
      fetched_at:   new Date().toISOString(),
    }),
  })

  if (!writeRes.ok) {
    return NextResponse.json({ ok: false, error: await writeRes.text() }, { status: 502 })
  }

  return NextResponse.json({ ok: true, airport, date, arrivals: arrivals.length, departures: departures.length })
}

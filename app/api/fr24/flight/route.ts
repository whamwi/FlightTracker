import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const FR24_KEY = process.env.FR24_API_KEY ?? ''

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const flight = searchParams.get('flight')
  if (!flight) return NextResponse.json({ ok: false, error: 'flight required' }, { status: 400 })

  const now  = new Date()
  const from = new Date(now.getTime() - 36 * 3_600_000).toISOString().slice(0, 19)
  const to   = now.toISOString().slice(0, 19)

  const params = new URLSearchParams({ flights: flight, flight_datetime_from: from, flight_datetime_to: to })
  const res = await fetch(`https://fr24api.flightradar24.com/api/flight-summary/full?${params}`, {
    headers: {
      Accept: 'application/json',
      'Accept-Version': 'v1',
      Authorization: `Bearer ${FR24_KEY}`,
    },
    signal: AbortSignal.timeout(12_000),
  })

  const text = await res.text()
  return NextResponse.json({ ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null })
}

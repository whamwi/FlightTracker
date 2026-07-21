import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const FR24_KEY = process.env.FR24_API_KEY ?? ''

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const flight_id   = searchParams.get('flight_id')
  const event_types = searchParams.get('event_types') ?? 'all'
  if (!flight_id) return NextResponse.json({ ok: false, error: 'flight_id required' }, { status: 400 })

  const params = new URLSearchParams({ flight_ids: flight_id, event_types })
  const res = await fetch(`https://fr24api.flightradar24.com/api/historic/flight-events/full?${params}`, {
    headers: {
      Accept:           'application/json',
      'Accept-Version': 'v1',
      Authorization:    `Bearer ${FR24_KEY}`,
    },
    signal: AbortSignal.timeout(12_000),
  })

  const text = await res.text()
  return NextResponse.json({ ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null })
}

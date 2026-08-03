import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const FR24_TOKEN = process.env.FR24_API_KEY

export async function GET(req: Request) {
  if (!FR24_TOKEN) {
    return NextResponse.json({ error: 'FR24_API_KEY not set' }, { status: 500 })
  }

  const callsign = new URL(req.url).searchParams.get('callsign') ?? 'FYC728'

  const now = new Date()
  const from = new Date(now.getTime() - 8 * 3_600_000).toISOString().slice(0, 19)
  const to   = now.toISOString().slice(0, 19)

  const url = `https://fr24api.flightradar24.com/api/flight-summary/light`
    + `?callsigns=${encodeURIComponent(callsign)}`
    + `&flight_datetime_from=${encodeURIComponent(from)}`
    + `&flight_datetime_to=${encodeURIComponent(to)}`
    + `&limit=5`

  const res = await fetch(url, {
    headers: {
      Authorization:    `Bearer ${FR24_TOKEN}`,
      Accept:           'application/json',
      'Accept-Version': 'v1',
    },
  })

  const body = await res.json()
  return NextResponse.json({ status: res.status, url, body })
}

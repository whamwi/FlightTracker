import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const FR24_TOKEN = process.env.FR24_API_KEY

export async function GET(req: Request) {
  if (!FR24_TOKEN) return NextResponse.json({ error: 'FR24_API_KEY not set' }, { status: 500 })

  const callsign = new URL(req.url).searchParams.get('callsign')
  if (!callsign) return NextResponse.json({ error: 'pass ?callsign=FYC728' }, { status: 400 })

  const url = `https://fr24api.flightradar24.com/api/live/flight-positions/light?callsigns=${encodeURIComponent(callsign)}`

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

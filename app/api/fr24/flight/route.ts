import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const FR24_KEY = process.env.FR24_API_KEY ?? ''

function fr24(path: string, params: Record<string, string>) {
  const url = `https://fr24api.flightradar24.com/api/${path}?${new URLSearchParams(params)}`
  return fetch(url, {
    headers: { Accept: 'application/json', 'Accept-Version': 'v1', Authorization: `Bearer ${FR24_KEY}` },
    signal: AbortSignal.timeout(12_000),
  })
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const flight = searchParams.get('flight')
  if (!flight) return NextResponse.json({ ok: false, error: 'flight required' }, { status: 400 })

  const now  = new Date()
  const from = new Date(now.getTime() - 36 * 3_600_000).toISOString().slice(0, 19)
  const to   = now.toISOString().slice(0, 19)

  // 1. Flight summary
  const sumRes = await fr24('flight-summary/full', { flights: flight, flight_datetime_from: from, flight_datetime_to: to })
  const sumText = await sumRes.text()
  const sumData = sumText ? JSON.parse(sumText) : null
  const fr24_id: string | null = sumData?.data?.[0]?.fr24_id ?? null

  // 2. If we have a fr24_id, fetch live position + position trail in parallel
  let liveData = null
  let trailData = null
  if (fr24_id) {
    const nowSec  = Math.floor(Date.now() / 1000)
    const fromSec = nowSec - 36 * 3600
    const safeJson = async (r: Response) => { try { return await r.json() } catch { return null } }
    const [liveRes, trailRes] = await Promise.all([
      fr24('live/flight-positions/full', { flight_ids: fr24_id }),
      fr24('historic/flight-positions/full', {
        flight_ids:     fr24_id,
        timestamp_from: String(fromSec),
        timestamp_to:   String(nowSec),
      }),
    ])
    ;[liveData, trailData] = await Promise.all([safeJson(liveRes), safeJson(trailRes)])
  }

  return NextResponse.json({
    ok: sumRes.ok,
    status: sumRes.status,
    summary: sumData,
    live: liveData,
    trail: trailData,
  })
}

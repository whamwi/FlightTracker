import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const ADB_KEY  = process.env.AERODATABOX_KEY!
const ADB_BASE = 'https://prod.api.market/api/v1/aedbx/aerodatabox'

export async function GET(req: Request) {
  const callsign = new URL(req.url).searchParams.get('callsign')
  if (!callsign) return NextResponse.json({ ok: false, error: 'callsign required' }, { status: 400 })

  const res = await fetch(`${ADB_BASE}/flights/callsign/${encodeURIComponent(callsign)}`, {
    headers: { 'x-api-market-key': ADB_KEY },
    signal: AbortSignal.timeout(12_000),
  })

  const text = await res.text()
  return NextResponse.json({ ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null })
}

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const ADB_KEY  = process.env.AERODATABOX_KEY!
const ADB_BASE = 'https://prod.api.market/api/v1/aedbx/aerodatabox'

export async function GET() {
  if (!ADB_KEY) {
    return NextResponse.json({ ok: false, error: 'AERODATABOX_KEY not configured' }, { status: 500 })
  }

  try {
    const res = await fetch(`${ADB_BASE}/subscriptions/webhook`, {
      headers: { 'x-api-market-key': ADB_KEY },
      signal: AbortSignal.timeout(12_000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({ ok: false, error: `ADB ${res.status}: ${text}` }, { status: 502 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any[] = await res.json()
    const subs = Array.isArray(data) ? data : []

    const flights = subs.map(s => {
      const raw = s.subjectId ?? s.subject
      const id = typeof raw === 'string' ? raw : (raw?.id ?? raw?.value ?? raw?.number ?? '')
      return {
        id:         s.id,
        flight:     id,
        isActive:   s.isActive,
        createdOn:  s.createdOnUtc,
        expiresOn:  s.expiresOnUtc ?? null,
      }
    })

    return NextResponse.json({ ok: true, count: flights.length, flights })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

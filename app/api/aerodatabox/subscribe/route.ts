import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ADB_KEY  = process.env.AERODATABOX_KEY!
const ADB_BASE = 'https://prod.api.market/api/v1/aedbx/aerodatabox'

// Key Syrian-route flight numbers — 10 subscriptions × 2 events/day = 20 credits/day
// 600 free credits ÷ 20 = 30 days coverage. Refill 60 credits every 3 days = 600 units/month.
const FLIGHT_NUMBERS = [
  'FYC743',  // FlyOne Armenia  DAM→SHJ
  'SYR272',  // Syrian Air      DAM→AMS
  'TK849',   // Turkish         DAM→IST
  'TK848',   // Turkish         IST→DAM
  'RJ436',   // Royal Jordanian DAM→AMM
  'RJ435',   // Royal Jordanian AMM→DAM
  'G9434',   // Air Arabia      SHJ→DAM
  'G9433',   // Air Arabia      DAM→SHJ
  'FZ1116',  // flydubai        DXB→DAM
  'FZ1115',  // flydubai        DAM→DXB
]

function adb(path: string, opts: RequestInit = {}) {
  return fetch(`${ADB_BASE}${path}`, {
    ...opts,
    headers: {
      'x-api-market-key': ADB_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string>),
    },
    signal: AbortSignal.timeout(15_000),
  })
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  if (!ADB_KEY) return NextResponse.json({ ok: false, error: 'AERODATABOX_KEY not set' }, { status: 500 })

  const webhookUrl = process.env.AERODATABOX_WEBHOOK_URL
  if (!webhookUrl) return NextResponse.json({ ok: false, error: 'AERODATABOX_WEBHOOK_URL not set' }, { status: 500 })

  const results: Record<string, unknown> = {}

  // 1. Check current credit balance
  const balRes = await adb('/subscriptions/balance')
  const balData = balRes.ok ? await balRes.json() : null
  const balance: number = balData?.balance ?? balData?.credits ?? 0
  results.balance_before = balance

  // 2. Refill if below 60 credits (enough for ~3 days at 20 credits/day)
  if (balance < 60) {
    const refillRes = await adb('/subscriptions/balance/refill', {
      method: 'POST',
      body: JSON.stringify({ credits: 60 }),
    })
    const refillData = refillRes.ok ? await refillRes.json() : { error: await refillRes.text() }
    results.refill = refillData
  }

  // 3. List existing subscriptions so we don't duplicate
  const listRes = await adb('/subscriptions/webhook')
  const existing: string[] = []
  if (listRes.ok) {
    const listData = await listRes.json()
    const subs = Array.isArray(listData) ? listData : (listData?.subscriptions ?? [])
    for (const s of subs) {
      const subId: string = s.subjectId ?? s.subject ?? ''
      if (subId) existing.push(subId.toUpperCase())
    }
  }
  results.existing = existing

  // 4. Subscribe to each flight number not already subscribed
  const webhookSecret = process.env.AERODATABOX_WEBHOOK_SECRET
  const fullUrl = webhookSecret ? `${webhookUrl}?secret=${webhookSecret}` : webhookUrl

  const created: string[] = []
  const skipped: string[] = []
  const errors: Record<string, string> = {}

  for (const flight of FLIGHT_NUMBERS) {
    if (existing.includes(flight.toUpperCase())) {
      skipped.push(flight)
      continue
    }

    const res = await adb(
      `/subscriptions/webhook/FlightByNumber/${encodeURIComponent(flight)}?useCredits=true`,
      {
        method: 'POST',
        body: JSON.stringify({ url: fullUrl, maxDeliveryRetries: 2 }),
      }
    )

    if (res.ok) {
      created.push(flight)
    } else {
      errors[flight] = `${res.status}: ${await res.text()}`
    }
  }

  results.created  = created
  results.skipped  = skipped
  results.errors   = errors

  return NextResponse.json({ ok: true, ...results })
}

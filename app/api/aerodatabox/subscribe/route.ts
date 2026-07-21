import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ADB_KEY  = process.env.AERODATABOX_KEY!
const ADB_BASE = 'https://prod.api.market/api/v1/aedbx/aerodatabox'
const SB_URL   = process.env.SUPABASE_URL!
const SB_KEY   = process.env.SUPABASE_ANON_KEY!

// Fetch broadcast callsigns from DB — these are the ICAO identifiers AeroDataBox uses.
// AeroDataBox FlightByNumber tracks by callsign (e.g. FDB1114, THY848), not IATA (FZ1114, TK848).
async function fetchBroadcastCallsigns(): Promise<string[]> {
  const res = await fetch(
    `${SB_URL}/rest/v1/rpc/get_syria_broadcast_callsigns`,
    {
      method: 'POST',
      headers: {
        apikey:          SB_KEY,
        Authorization:   `Bearer ${SB_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!res.ok) throw new Error(`DB callsigns fetch failed: ${res.status}`)
  const rows: { broadcast_callsign: string }[] = await res.json()
  return rows.map(r => r.broadcast_callsign).filter(Boolean)
}

function adb(path: string, opts: RequestInit = {}) {
  return fetch(`${ADB_BASE}${path}`, {
    ...opts,
    headers: {
      'x-api-market-key': ADB_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string>),
    },
    signal: AbortSignal.timeout(12_000),
  })
}

export async function GET(req: Request) {
  try {
    const secret = process.env.CRON_SECRET
    if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    if (!ADB_KEY) return NextResponse.json({ ok: false, error: 'AERODATABOX_KEY not set' }, { status: 500 })

    const webhookUrl = process.env.AERODATABOX_WEBHOOK_URL
    if (!webhookUrl) return NextResponse.json({ ok: false, error: 'AERODATABOX_WEBHOOK_URL not set' }, { status: 500 })

    // 1. Fetch broadcast callsigns from DB + check balance/existing subs in parallel
    const [allCallsigns, balRes, listRes] = await Promise.all([
      fetchBroadcastCallsigns(),
      adb('/subscriptions/balance'),
      adb('/subscriptions/webhook'),
    ])

    if (allCallsigns.length === 0) {
      return NextResponse.json({ ok: false, error: 'No callsigns returned from DB' }, { status: 500 })
    }

    const safeJson = async (r: Response) => { try { return await r.json() } catch { return null } }

    const balData = balRes.ok ? await safeJson(balRes) : null
    const balance: number = balData?.balance ?? balData?.credits ?? balData?.availableCredits ?? 0

    let refillResult: unknown = null
    if (balance < 120) {
      const refillRes = await adb('/subscriptions/balance/refill', {
        method: 'POST',
        body: JSON.stringify({ credits: 60 }),
      })
      refillResult = refillRes.ok ? await safeJson(refillRes) : { error: await refillRes.text() }
    }

    // 2. Collect existing subscriptions
    const existing = new Set<string>()
    if (listRes.ok) {
      const listData = await safeJson(listRes)
      const subs = Array.isArray(listData) ? listData : (listData?.subscriptions ?? [])
      for (const s of subs) {
        const raw = s.subjectId ?? s.subject
        const subId = typeof raw === 'string' ? raw : (raw?.id ?? raw?.value ?? raw?.number ?? '')
        if (subId) existing.add(String(subId).toUpperCase())
      }
    }

    const webhookSecret = process.env.AERODATABOX_WEBHOOK_SECRET
    const fullUrl = webhookSecret ? `${webhookUrl}?secret=${webhookSecret}` : webhookUrl

    // 3. Subscribe missing callsigns in parallel batches of 10
    const toSubscribe = allCallsigns.filter(cs => !existing.has(cs.toUpperCase()))
    const created: string[] = []
    const errors: Record<string, string> = {}

    const BATCH = 10
    for (let i = 0; i < toSubscribe.length; i += BATCH) {
      const batch = toSubscribe.slice(i, i + BATCH)
      await Promise.all(batch.map(async callsign => {
        const res = await adb(
          `/subscriptions/webhook/FlightByNumber/${encodeURIComponent(callsign)}?useCredits=true`,
          { method: 'POST', body: JSON.stringify({ url: fullUrl, maxDeliveryRetries: 2 }) },
        )
        if (res.ok) created.push(callsign)
        else errors[callsign] = `${res.status}: ${await res.text().catch(() => '(no body)')}`
      }))
    }

    return NextResponse.json({
      ok: true,
      balance_before:  balance,
      refill:          refillResult,
      total_from_db:   allCallsigns.length,
      existing_count:  existing.size,
      created,
      skipped_count:   allCallsigns.length - toSubscribe.length,
      errors,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

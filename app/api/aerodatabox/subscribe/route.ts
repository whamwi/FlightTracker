import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ADB_KEY  = process.env.AERODATABOX_KEY!
const ADB_BASE = 'https://prod.api.market/api/v1/aedbx/aerodatabox'
const SB_URL   = process.env.SUPABASE_URL!
const SB_KEY   = process.env.SUPABASE_ANON_KEY!

// Fetch {iata_number, broadcast_callsign} pairs from DB.
// ADB subscriptions may be stored under either identifier (IATA or broadcast);
// we need both to skip flights that are already covered under their alias.
async function fetchFlightPairs(): Promise<{ iata: string; callsign: string }[]> {
  const res = await fetch(
    `${SB_URL}/rest/v1/rpc/get_syria_flight_pairs`,
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
  if (!res.ok) throw new Error(`DB flight pairs fetch failed: ${res.status}`)
  const rows: { iata_number: string; broadcast_callsign: string }[] = await res.json()
  return rows
    .filter(r => r.broadcast_callsign)
    .map(r => ({ iata: r.iata_number ?? '', callsign: r.broadcast_callsign }))
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

    // 1. Fetch flight pairs from DB + check balance/existing subs in parallel
    const [pairs, balRes, listRes] = await Promise.all([
      fetchFlightPairs(),
      adb('/subscriptions/balance'),
      adb('/subscriptions/webhook'),
    ])

    if (pairs.length === 0) {
      return NextResponse.json({ ok: false, error: 'No flights returned from DB' }, { status: 500 })
    }

    const safeJson = async (r: Response) => { try { return await r.json() } catch { return null } }

    const balData = balRes.ok ? await safeJson(balRes) : null
    const balance: number = balData?.balance ?? balData?.credits ?? balData?.availableCredits ?? 0

    let refillResult: unknown = null
    if (balance < 500) {
      const refillRes = await adb('/subscriptions/balance/refill', {
        method: 'POST',
        body: JSON.stringify({ credits: 500 }),
      })
      refillResult = refillRes.ok ? await safeJson(refillRes) : { error: await refillRes.text() }
    }

    // 2. Collect existing subscriptions
    const existing = new Set<string>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let existingSubs: any[] = []
    if (listRes.ok) {
      const listData = await safeJson(listRes)
      existingSubs = Array.isArray(listData) ? listData : (listData?.subscriptions ?? [])
      for (const s of existingSubs) {
        const raw = s.subjectId ?? s.subject
        const subId = typeof raw === 'string' ? raw : (raw?.id ?? raw?.value ?? raw?.number ?? '')
        // ADB stores subjects as "DN 551" (with space); normalise to "DN551" to match our iata_number format
        if (subId) existing.add(String(subId).toUpperCase().replace(/\s+/g, ''))
      }
    }

    const webhookSecret = process.env.AERODATABOX_WEBHOOK_SECRET
    const fullUrl = webhookSecret ? `${webhookUrl}?secret=${webhookSecret}` : webhookUrl

    // ?force=true: delete all existing subscriptions first, then re-subscribe everything.
    // Use this when the webhook URL changed and old subs point to the wrong endpoint.
    const url = new URL(req.url)
    const force = url.searchParams.get('force') === 'true'
    let deleted: string[] = []
    if (force && existingSubs.length > 0) {
      await Promise.all(existingSubs.map(async s => {
        // Try deletion by subscription numeric ID first, then by subject flight number
        const numId: string | undefined = s.id ?? s.subscriptionId
        const subject: string | undefined = (() => {
          const raw = s.subjectId ?? s.subject
          return typeof raw === 'string' ? raw : (raw?.id ?? raw?.value ?? raw?.number ?? undefined)
        })()
        const delPath = numId
          ? `/subscriptions/webhook/${numId}`
          : subject
            ? `/subscriptions/webhook/FlightByNumber/${encodeURIComponent(subject)}`
            : null
        if (!delPath) return
        try {
          await adb(delPath, { method: 'DELETE' })
          deleted.push(numId ?? subject ?? '')
        } catch { /* best-effort */ }
      }))
      // After deletion, everything needs re-subscribing
      existing.clear()
    }

    // 3. Subscribe using broadcast callsign; skip if IATA or callsign already exists.
    // ADB stores subscriptions under IATA aliases (G9 352 for ABY352) so we check both.
    const toSubscribe = pairs.filter(
      p => !existing.has(p.callsign.toUpperCase()) && !existing.has(p.iata.toUpperCase().replace(/\s+/g, '')),
    )
    const created: string[] = []
    const alreadyCovered: string[] = []
    const errors: Record<string, string> = {}

    const BATCH = 10
    for (let i = 0; i < toSubscribe.length; i += BATCH) {
      const batch = toSubscribe.slice(i, i + BATCH)
      await Promise.all(batch.map(async ({ callsign }) => {
        const res = await adb(
          `/subscriptions/webhook/FlightByNumber/${encodeURIComponent(callsign)}?useCredits=true`,
          { method: 'POST', body: JSON.stringify({ url: fullUrl, maxDeliveryRetries: 2 }) },
        )
        if (res.ok) {
          created.push(callsign)
        } else {
          const body = await res.text().catch(() => '')
          // ADB returns 400 when the flight is already subscribed under its IATA alias —
          // this is "covered", not a real error.
          if (res.status === 400 && body.toLowerCase().includes('already')) {
            alreadyCovered.push(callsign)
          } else {
            errors[callsign] = `${res.status}: ${body}`
          }
        }
      }))
    }

    const showList = url.searchParams.get('list') === 'true'

    return NextResponse.json({
      ok: true,
      balance_before:   balance,
      refill:           refillResult,
      total_from_db:    pairs.length,
      existing_count:   existing.size,
      existing_subs:    showList ? existingSubs : undefined,
      deleted:          deleted.length,
      skipped_db_match: pairs.length - toSubscribe.length,
      created,
      already_covered:  alreadyCovered.length,
      errors,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

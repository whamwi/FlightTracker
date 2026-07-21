import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ADB_KEY  = process.env.AERODATABOX_KEY!
const ADB_BASE = 'https://prod.api.market/api/v1/aedbx/aerodatabox'

// All IATA flight numbers serving Syrian airports (DAM / ALP).
// Sourced from flight_schedule × flight_lookup — update when schedule changes.
const ALL_FLIGHTS = [
  // Air Arabia (G9)
  'G9351','G9352','G9363','G9364','G9375','G9376','G9433','G9434',
  // Etihad (EY)
  'EY561','EY562',
  // Flynas (F3)
  'F3561','F3562','F3741','F3742',
  // flydubai (FZ)
  'FZ1113','FZ1114','FZ1115','FZ1116','FZ1847','FZ1848',
  // FlyOne Armenia — AeroDataBox identifies by ICAO callsign (FYC) not IATA (XH)
  'FYC361','FYC362','FYC455','FYC456',
  'FYC485','FYC486','FYC489','FYC490','FYC491','FYC492',
  'FYC501','FYC502','FYC521','FYC522','FYC523','FYC524','FYC525','FYC526',
  'FYC701','FYC702','FYC725','FYC726','FYC727','FYC728',
  'FYC731','FYC732','FYC741','FYC742','FYC743','FYC744',
  'FYC761','FYC762','FYC781','FYC782','FYC831','FYC832',
  // Jubba Airways (DN)
  'DN541','DN542','DN551','DN552',
  // Jazeera Airways (J9)
  'J9171','J9172','J9173','J9174','J9175','J9176','J9177','J9178','J9181','J9182',
  // Kuwait Airways (KU)
  'KU551','KU552',
  // Nesma Airlines (XY)
  'XY377','XY378','XY387','XY388','XY591','XY592','XY892','XY893',
  // Pegasus (PC)
  'PC770','PC771',
  // Qatar Airways (QR)
  'QR410','QR411',
  // Royal Jordanian (RJ)
  'RJ237','RJ431','RJ432','RJ433','RJ434','RJ435','RJ436','RJ437','RJ438',
  // Syrian Air (RB)
  'RB271','RB272','RB341','RB342',
  'RB381','RB382','RB389','RB390',
  'RB443','RB444','RB445','RB446',
  'RB501','RB502','RB503','RB504','RB515','RB516','RB521','RB522',
  // Turkish Airlines (TK)
  'TK840','TK841','TK844','TK845','TK846','TK847','TK848','TK849',
  // Tailwind / VF
  'VF317','VF318','VF340','VF341','VF591','VF592',
]

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

    // 1. Check balance and refill in parallel with listing existing subs
    const [balRes, listRes] = await Promise.all([
      adb('/subscriptions/balance'),
      adb('/subscriptions/webhook'),
    ])

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
        // subject may be a string ID or an object { type, id } depending on ADB response version
        const raw = s.subjectId ?? s.subject
        const subId: string = typeof raw === 'string' ? raw : (raw?.id ?? raw?.value ?? raw?.number ?? '')
        if (subId) existing.add(subId.toUpperCase())
      }
    }

    const webhookSecret = process.env.AERODATABOX_WEBHOOK_SECRET
    const fullUrl = webhookSecret ? `${webhookUrl}?secret=${webhookSecret}` : webhookUrl

    // 3. Subscribe in parallel batches of 10 to stay within timeout
    const toSubscribe = ALL_FLIGHTS.filter(f => !existing.has(f.toUpperCase()))
    const created: string[] = []
    const skipped = ALL_FLIGHTS.filter(f => existing.has(f.toUpperCase()))
    const errors: Record<string, string> = {}

    const BATCH = 10
    for (let i = 0; i < toSubscribe.length; i += BATCH) {
      const batch = toSubscribe.slice(i, i + BATCH)
      await Promise.all(batch.map(async flight => {
        const res = await adb(
          `/subscriptions/webhook/FlightByNumber/${encodeURIComponent(flight)}?useCredits=true`,
          { method: 'POST', body: JSON.stringify({ url: fullUrl, maxDeliveryRetries: 2 }) }
        )
        if (res.ok) created.push(flight)
        else errors[flight] = `${res.status}: ${await res.text().catch(() => '(no body)')}`
      }))
    }

    return NextResponse.json({
      ok: true,
      balance_before: balance,
      refill: refillResult,
      existing_count: existing.size,
      total: ALL_FLIGHTS.length,
      created,
      skipped_count: skipped.length,
      errors,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

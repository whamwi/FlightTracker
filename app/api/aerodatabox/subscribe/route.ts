import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ADB_KEY  = process.env.AERODATABOX_KEY!
const ADB_BASE = 'https://prod.api.market/api/v1/aedbx/aerodatabox'
const SB_URL   = process.env.SUPABASE_URL!
const SB_KEY   = process.env.SUPABASE_ANON_KEY!

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

// Pull all unique IATA flight numbers that serve Syrian airports from our schedule
async function getScheduledFlightNumbers(): Promise<string[]> {
  const res = await fetch(
    `${SB_URL}/rest/v1/rpc/get_syria_callsigns`,
    {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }
  )
  if (!res.ok) return FALLBACK_FLIGHTS

  // get_syria_callsigns returns broadcast_callsign — we need iata_number
  // Query flight_lookup directly for the iata mapping
  const flRes = await fetch(
    `${SB_URL}/rest/v1/flight_lookup?select=iata_number&iata_number=not.is.null`,
    {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    }
  )
  if (!flRes.ok) return FALLBACK_FLIGHTS

  const rows: { iata_number: string }[] = await flRes.json()

  // Also need to cross-reference which ones have Syria routes
  const schedRes = await fetch(
    `${SB_URL}/rest/v1/flight_schedule?select=flight_id,dep_iata,arr_iata&or=(dep_iata.in.(DAM,ALP),arr_iata.in.(DAM,ALP))`,
    {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    }
  )
  if (!schedRes.ok) return FALLBACK_FLIGHTS

  const schedRows: { flight_id: number }[] = await schedRes.json()
  const syriaFlightIds = new Set(schedRows.map(r => r.flight_id))

  // Get all flight_lookup rows that have Syria schedule entries
  const lookupRes = await fetch(
    `${SB_URL}/rest/v1/flight_lookup?select=id,iata_number&iata_number=not.is.null`,
    {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    }
  )
  if (!lookupRes.ok) return FALLBACK_FLIGHTS

  const lookupRows: { id: number; iata_number: string }[] = await lookupRes.json()
  const numbers = lookupRows
    .filter(r => syriaFlightIds.has(r.id) && r.iata_number)
    .map(r => r.iata_number)

  return numbers.length > 0 ? [...new Set(numbers)] : FALLBACK_FLIGHTS
}

// Fallback list if DB is unreachable — covers the most important routes
const FALLBACK_FLIGHTS = [
  // Turkish Airlines
  'TK840', 'TK841', 'TK844', 'TK845', 'TK846', 'TK847', 'TK848', 'TK849',
  // flydubai
  'FZ1113', 'FZ1114', 'FZ1115', 'FZ1116', 'FZ1847', 'FZ1848',
  // Etihad
  'EY561', 'EY562',
  // Qatar Airways
  'QR410', 'QR411',
  // Royal Jordanian
  'RJ431', 'RJ432', 'RJ433', 'RJ435', 'RJ436',
  // Kuwait Airways
  'KU551', 'KU552',
  // Jazeera
  'J9171', 'J9172', 'J9173', 'J9174', 'J9177', 'J9178', 'J9181', 'J9182',
  // Air Arabia
  'G9351', 'G9352', 'G9363', 'G9364', 'G9375', 'G9376', 'G9433', 'G9434',
  // FlyOne Armenia (key routes)
  'XH485', 'XH486', 'XH743', 'XH744', 'XH727', 'XH728', 'XH701', 'XH702',
  // Syrian Air (key routes)
  'RB271', 'RB272', 'RB443', 'RB444', 'RB501', 'RB502',
  // Pegasus
  'PC770', 'PC771',
]

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

  // 2. Refill if below 120 credits (~2 days buffer at 60 credits/refill)
  if (balance < 120) {
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
  results.existing_count = existing.length

  // 4. Get full flight number list from schedule DB
  const flightNumbers = await getScheduledFlightNumbers()
  results.total_to_subscribe = flightNumbers.length

  // 5. Subscribe to each flight number not already subscribed
  const webhookSecret = process.env.AERODATABOX_WEBHOOK_SECRET
  const fullUrl = webhookSecret ? `${webhookUrl}?secret=${webhookSecret}` : webhookUrl

  const created: string[] = []
  const skipped: string[] = []
  const errors: Record<string, string> = {}

  for (const flight of flightNumbers) {
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

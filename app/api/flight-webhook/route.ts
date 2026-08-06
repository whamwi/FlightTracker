import { NextResponse } from 'next/server'

/**
 * Receives flight-status pushes from a provider under evaluation.
 *
 * Its purpose is measurement, not production. Two of the three providers we are considering
 * bill per notification, so the deciding number is how many notifications a flight actually
 * generates in a day — something no pricing page states and no salesperson will commit to.
 * The only way to know is to subscribe to real flights and count what arrives.
 *
 * Everything is stored raw alongside the parsed fields. We do not yet know which fields
 * matter, and a trial that throws away what it did not think to parse has to be run twice.
 *
 * Guarded by a token in the query string rather than a header: a provider's webhook
 * configuration is usually a single URL field with nowhere to put one. The token stops the
 * table filling with noise from anyone who finds the path; it is not protecting anything
 * sensitive, since the contents are public flight movements.
 */

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!
const TOKEN  = process.env.WEBHOOK_TOKEN

const PROVIDERS = new Set(['airlabs', 'variflight', 'aerodatabox', 'test'])

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Pull the identifying fields out of whatever shape arrived.
 *
 * AirLabs nests the flight under `flight` with a `changed` array beside it; VariFlight uses
 * FlightNo/FlightDepcode in PascalCase. Both are tried, and anything unrecognised still lands
 * in the table with its payload intact rather than being rejected.
 */
function parse(body: any): Record<string, unknown> {
  const f = body?.flight ?? body ?? {}
  const changed: string[] | null = Array.isArray(body?.changed) ? body.changed
    : Array.isArray(f?.changed) ? f.changed
    : null

  return {
    flight_iata: f.flight_iata ?? f.FlightNo ?? null,
    flight_icao: f.flight_icao ?? null,
    dep_iata:    f.dep_iata ?? f.FlightDepcode ?? null,
    arr_iata:    f.arr_iata ?? f.FlightArrcode ?? null,
    status:      f.status ?? f.FlightState ?? null,
    changed,
  }
}

export async function POST(req: Request) {
  const url      = new URL(req.url)
  const provider = (url.searchParams.get('provider') ?? 'airlabs').toLowerCase()

  // Rejected quietly with 200 rather than 401: a provider that sees an error status may
  // disable the subscription, and during a trial that loses the very data being gathered.
  if (TOKEN && url.searchParams.get('token') !== TOKEN) {
    console.warn('[flight-webhook] rejected: bad or missing token')
    return NextResponse.json({ ok: true })
  }
  if (!PROVIDERS.has(provider)) {
    console.warn(`[flight-webhook] rejected: unknown provider ${provider}`)
    return NextResponse.json({ ok: true })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 })
  }

  // A provider may batch several flights into one request.
  const items: any[] = Array.isArray(body) ? body : [body]
  const rows = items.slice(0, 100).map(item => ({
    provider,
    ...parse(item),
    payload: item,
  }))

  const res = await fetch(`${SB_URL}/rest/v1/flight_webhook_event`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  })

  if (!res.ok) {
    // Logged loudly: a silently failing recorder during a paid trial means paying for data
    // that was never captured, and looks identical to a provider sending nothing.
    console.error('[flight-webhook] write failed', res.status, (await res.text()).slice(0, 300))
    return NextResponse.json({ ok: false }, { status: 500 })
  }
  return NextResponse.json({ ok: true, stored: rows.length })
}

/** Some providers verify a webhook with a GET before they will accept the URL. */
export async function GET() {
  return NextResponse.json({ ok: true, service: 'flight-webhook' })
}

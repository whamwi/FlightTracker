import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_ANON_KEY!
const PF_KEY  = process.env.PLANEFINDER_API_KEY!
const PF_BASE = 'https://api.planefinder.net/api/v1'

// Fetch historic flight records from Planefinder for a callsign on a given date.
// Returns { firstSeen, lastSeen } as ISO strings, or null if no record found.
async function fetchPlanefinderStatus(
  callsign: string,
  flightDateUtc: string,  // YYYY-MM-DD (UTC date of scheduled departure)
): Promise<{ firstSeen: string; lastSeen: string; reg: string | null } | null> {
  // Query a 36-hour window centred on the departure date to handle overnight flights.
  // from = day before at 12:00 UTC, to = next day at 12:00 UTC.
  const from = Math.floor(new Date(`${flightDateUtc}T00:00:00Z`).getTime() / 1000) - 12 * 3600
  const to   = Math.floor(new Date(`${flightDateUtc}T00:00:00Z`).getTime() / 1000) + 36 * 3600

  const url = new URL(`${PF_BASE}/historic/flights`)
  url.searchParams.set('callsign', callsign)
  url.searchParams.set('from',     String(from))
  url.searchParams.set('to',       String(to))

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${PF_KEY}` },
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    console.error(`[planefinder] historic/flights ${res.status}`, await res.text())
    return null
  }

  const body = await res.json()
  const records: { firstSeen: number; lastSeen: number; reg?: string }[] = body?.data ?? []

  if (records.length === 0) return null

  // Pick the record with the latest firstSeen within the window — most likely today's flight.
  const best = records.reduce((a, b) => (a.firstSeen > b.firstSeen ? a : b))

  return {
    firstSeen: new Date(best.firstSeen * 1000).toISOString(),
    lastSeen:  new Date(best.lastSeen  * 1000).toISOString(),
    reg:       best.reg ?? null,
  }
}

// Write atd/ata back into flight_instance for the given callsign + date.
async function updateFlightInstance(
  callsign: string,
  flightDate: string,
  atd: string,
  ata: string,
  reg: string | null,
) {
  // Resolve flight_id from callsign.
  const flRes = await fetch(
    `${SB_URL}/rest/v1/flight_lookup?broadcast_callsign=eq.${encodeURIComponent(callsign)}&select=id`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  )
  if (!flRes.ok) throw new Error(`flight_lookup fetch failed: ${flRes.status}`)
  const flRows: { id: number }[] = await flRes.json()
  if (flRows.length === 0) throw new Error(`callsign ${callsign} not found in flight_lookup`)
  const flight_id = flRows[0].id

  // PATCH flight_instance.
  const patch: Record<string, string | null> = { atd, ata, status: 'arrived' }
  if (reg) patch.aircraft_reg = reg

  const pRes = await fetch(
    `${SB_URL}/rest/v1/flight_instance?flight_id=eq.${flight_id}&flight_date=eq.${flightDate}`,
    {
      method:  'PATCH',
      headers: {
        apikey:         SB_KEY,
        Authorization:  `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body: JSON.stringify(patch),
    },
  )
  if (!pRes.ok) throw new Error(`flight_instance PATCH failed: ${pRes.status} ${await pRes.text()}`)
}

export async function POST(req: Request) {
  if (!PF_KEY) {
    return NextResponse.json({ ok: false, error: 'PLANEFINDER_API_KEY not configured' }, { status: 503 })
  }

  let body: { callsign?: string; date?: string }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }) }

  const { callsign, date } = body
  if (!callsign || !date) {
    return NextResponse.json({ ok: false, error: 'callsign and date required' }, { status: 400 })
  }

  const result = await fetchPlanefinderStatus(callsign, date)
  if (!result) {
    return NextResponse.json({ ok: false, error: `No Planefinder record found for ${callsign} on ${date}` })
  }

  await updateFlightInstance(callsign, date, result.firstSeen, result.lastSeen, result.reg)

  return NextResponse.json({
    ok:        true,
    callsign,
    date,
    atd:       result.firstSeen,
    ata:       result.lastSeen,
    reg:       result.reg,
  })
}

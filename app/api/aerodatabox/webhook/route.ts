import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

async function sb(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
      ...(opts.headers as Record<string, string>),
    },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`)
}

function delayMin(scheduled: string | undefined, actual: string | undefined): number | null {
  if (!scheduled || !actual) return null
  return Math.round((new Date(actual).getTime() - new Date(scheduled).getTime()) / 60_000)
}

function hasLive(quality: string[] | undefined): boolean {
  return Array.isArray(quality) && quality.includes('Live')
}

const ADB_STATUS: Record<number, string> = {
  0:  'Unknown',
  1:  'Expected',
  2:  'En Route',
  3:  'CheckIn',
  4:  'Boarding',
  5:  'GateClosed',
  6:  'Departed',
  7:  'Approaching',
  8:  'Arrived',
  9:  'Cancelled',
  10: 'Diverted',
  11: 'Cancelled',
}

// Normalise string variants ADB sometimes sends instead of numeric codes
const ADB_STRING_ALIAS: Record<string, string> = {
  Landed:    'Arrived',
  Land:      'Arrived',
  Takeoff:   'Departed',
  Enroute:   'En Route',
  EnRoute:   'En Route',
}

function resolveStatus(raw: unknown): string {
  if (typeof raw === 'number') return ADB_STATUS[raw] ?? 'Unknown'
  if (typeof raw === 'string') {
    const n = Number(raw)
    if (!isNaN(n) && raw.trim() !== '') return ADB_STATUS[n] ?? 'Unknown'
    return ADB_STRING_ALIAS[raw] ?? raw
  }
  return 'Unknown'
}

// Fetch IATA number → broadcast callsign mapping so webhook payloads that
// omit callSign (sending only number/IATA) can still be keyed correctly.
async function fetchIataToCallsign(): Promise<Record<string, string>> {
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/rpc/get_syria_flight_pairs`,
      {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5_000),
      },
    )
    if (!res.ok) return {}
    const rows: { iata_number: string; broadcast_callsign: string }[] = await res.json()
    const map: Record<string, string> = {}
    for (const r of rows) {
      if (r.iata_number && r.broadcast_callsign) map[r.iata_number.toUpperCase()] = r.broadcast_callsign
    }
    return map
  } catch { return {} }
}

// Normalise a single AeroDataBox flight object into a flight_status row
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRow(f: any, iataToCallsign: Record<string, string>): object | null {
  // ADB webhook payloads sometimes omit callSign and only send number (IATA).
  const callSign: string | undefined =
    f.callSign ?? iataToCallsign[(f.number ?? '').toString().toUpperCase().replace(/\s+/g, '')] ?? undefined
  if (!callSign) return null

  const dep = f.departure ?? {}
  const arr = f.arrival ?? {}
  const depLive = hasLive(dep.quality)
  const arrLive = hasLive(arr.quality)

  const schedDep = dep.scheduledTime?.utc
  const actualDep = depLive ? (dep.runwayTime?.utc ?? dep.revisedTime?.utc) : undefined
  const schedArr  = arr.scheduledTime?.utc
  const actualArr = arrLive ? (arr.runwayTime?.utc ?? arr.revisedTime?.utc) : undefined

  const opDate = (schedDep ?? schedArr ?? new Date().toISOString()).slice(0, 10)

  const revisedDep = dep.revisedTime?.utc
  const revisedArr = arr.revisedTime?.utc

  return {
    callsign:          callSign,
    operating_date:    opDate,
    flight_number:     f.number ?? null,
    dep_iata:          dep.airport?.iata ?? null,
    arr_iata:          arr.airport?.iata ?? null,
    dep_icao:          dep.airport?.icao ?? null,
    arr_icao:          arr.airport?.icao ?? null,
    status:            resolveStatus(f.status),
    scheduled_dep_utc: schedDep   ? new Date(schedDep).toISOString()   : null,
    actual_dep_utc:    actualDep  ? new Date(actualDep).toISOString()  : null,
    revised_dep_utc:   revisedDep ? new Date(revisedDep).toISOString() : null,
    scheduled_arr_utc: schedArr   ? new Date(schedArr).toISOString()   : null,
    actual_arr_utc:    actualArr  ? new Date(actualArr).toISOString()  : null,
    revised_arr_utc:   revisedArr ? new Date(revisedArr).toISOString() : null,
    dep_delay_min:     delayMin(schedDep, actualDep),
    arr_delay_min:     delayMin(schedArr, actualArr),
    dep_terminal:      dep.terminal      ?? null,
    dep_gate:          dep.gate          ?? null,
    dep_check_in_desk: dep.checkInDesk   ?? null,
    arr_terminal:      arr.terminal      ?? null,
    arr_gate:          arr.gate          ?? null,
    arr_baggage_belt:  arr.baggageBelt   ?? null,
    aircraft_reg:      f.aircraft?.reg   ?? null,
    aircraft_type:     f.aircraft?.model ?? null,
    airline_name:      f.airline?.name   ?? null,
    airline_iata:      f.airline?.iata   ?? null,
    airline_icao:      f.airline?.icao   ?? null,
    is_cargo:          f.isCargo         ?? null,
    dep_quality:       dep.quality ?? [],
    arr_quality:       arr.quality ?? [],
    last_synced_at:    new Date().toISOString(),
  }
}

export async function POST(req: Request) {
  // Optional webhook secret check
  const secret = process.env.AERODATABOX_WEBHOOK_SECRET
  if (secret) {
    const url = new URL(req.url)
    if (url.searchParams.get('secret') !== secret) {
      return NextResponse.json({ ok: false }, { status: 401 })
    }
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = body as any
  const remainingCredits: number | undefined = payload?.balance?.creditsRemaining ?? payload?.remainingCredits
  // Log top-level shape to diagnose payload structure issues
  const topKeys = payload && typeof payload === 'object' ? Object.keys(payload) : []
  console.log(`[ADB webhook] keys=${topKeys.join(',')} remainingCredits=${remainingCredits} isArray=${Array.isArray(payload)}`)
  if (payload?.callSign || payload?.number) {
    console.log(`[ADB webhook] single-flight callSign=${payload.callSign} number=${payload.number} status=${payload.status}`)
  }

  // Normalise payload — handles both FlightByNumber and FlightByAirportIcao formats
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let flights: any[] = []
  if (Array.isArray(payload)) {
    flights = payload
  } else if (payload?.flights && Array.isArray(payload.flights)) {
    flights = payload.flights
  } else if (payload?.departures || payload?.arrivals) {
    flights = [...(payload.departures ?? []), ...(payload.arrivals ?? [])]
  } else if (payload?.callSign || payload?.number) {
    flights = [payload]
  }

  const iataToCallsign = await fetchIataToCallsign()
  const rows = flights.map(f => toRow(f, iataToCallsign)).filter(Boolean)

  if (rows.length > 0) {
    await sb('/flight_status', {
      method: 'POST',
      body: JSON.stringify(rows),
    })
  }

  // Log every webhook hit so we can verify delivery
  try {
    const firstFlight = flights[0]
    await sb('/webhook_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        callsign:   firstFlight?.callSign ?? null,
        flight_num: firstFlight?.number   ?? null,
        status:     firstFlight ? String(firstFlight.status ?? '') : null,
        credits:    remainingCredits != null ? Math.round(remainingCredits) : null,
        payload,
      }),
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ ok: true, processed: rows.length, remainingCredits })
}

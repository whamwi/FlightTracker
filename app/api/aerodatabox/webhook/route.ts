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

// Normalise a single AeroDataBox flight object into a flight_status row
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRow(f: any): object | null {
  const callSign: string | undefined = f.callSign
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

  return {
    callsign:          callSign,
    operating_date:    opDate,
    flight_number:     f.number ?? null,
    dep_iata:          dep.airport?.iata ?? null,
    arr_iata:          arr.airport?.iata ?? null,
    dep_icao:          dep.airport?.icao ?? null,
    arr_icao:          arr.airport?.icao ?? null,
    status:            f.status ?? 'Unknown',
    scheduled_dep_utc: schedDep  ? new Date(schedDep).toISOString()  : null,
    actual_dep_utc:    actualDep ? new Date(actualDep).toISOString() : null,
    scheduled_arr_utc: schedArr  ? new Date(schedArr).toISOString()  : null,
    actual_arr_utc:    actualArr ? new Date(actualArr).toISOString() : null,
    dep_delay_min:     delayMin(schedDep, actualDep),
    arr_delay_min:     delayMin(schedArr, actualArr),
    aircraft_reg:      f.aircraft?.reg  ?? null,
    aircraft_type:     f.aircraft?.model ?? null,
    airline_name:      f.airline?.name  ?? null,
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

  // Log remaining balance if provided in the notification
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = body as any
  const remainingCredits: number | undefined = payload?.remainingCredits ?? payload?.balance
  if (remainingCredits !== undefined) {
    console.log(`[ADB webhook] remaining credits: ${remainingCredits}`)
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

  const rows = flights.map(toRow).filter(Boolean)

  if (rows.length > 0) {
    await sb('/flight_status', {
      method: 'POST',
      body: JSON.stringify(rows),
    })
  }

  return NextResponse.json({ ok: true, processed: rows.length, remainingCredits })
}

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const ADB_KEY = process.env.AERODATABOX_KEY!
const ADB_BASE = 'https://prod.api.market/api/v1/aedbx/aerodatabox'

async function sb(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(opts.headers as Record<string, string>),
    },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

function delayMin(scheduled: string | undefined, actual: string | undefined): number | null {
  if (!scheduled || !actual) return null
  const diff = (new Date(actual).getTime() - new Date(scheduled).getTime()) / 60_000
  return Math.round(diff)
}

function hasLive(quality: string[] | undefined): boolean {
  return Array.isArray(quality) && quality.includes('Live')
}

interface AdbFlight {
  number?: string
  callSign?: string
  status?: string
  isCargo?: boolean
  aircraft?: { reg?: string; model?: string }
  airline?: { name?: string }
  departure?: {
    airport?: { iata?: string; icao?: string }
    scheduledTime?: { utc?: string }
    revisedTime?: { utc?: string }
    runwayTime?: { utc?: string }
    quality?: string[]
  }
  arrival?: {
    airport?: { iata?: string; icao?: string }
    scheduledTime?: { utc?: string }
    revisedTime?: { utc?: string }
    runwayTime?: { utc?: string }
    quality?: string[]
  }
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  if (!ADB_KEY) {
    return NextResponse.json({ ok: false, error: 'AERODATABOX_KEY not set' }, { status: 500 })
  }

  const res = await fetch(
    `${ADB_BASE}/flights/airports/icao/OSDI?withLeg=true&withCancelled=true&direction=Both`,
    {
      headers: { 'x-api-market-key': ADB_KEY },
      signal: AbortSignal.timeout(15_000),
    }
  )

  if (!res.ok) {
    const body = await res.text()
    return NextResponse.json({ ok: false, error: `AeroDataBox ${res.status}: ${body}` }, { status: 502 })
  }

  const data = await res.json() as { departures?: AdbFlight[]; arrivals?: AdbFlight[] }
  const flights: AdbFlight[] = [...(data.departures ?? []), ...(data.arrivals ?? [])]

  const today = new Date().toISOString().slice(0, 10)

  const rows = flights
    .filter(f => f.callSign && f.status !== undefined)
    .map(f => {
      const dep = f.departure
      const arr = f.arrival
      const depLive = hasLive(dep?.quality)
      const arrLive = hasLive(arr?.quality)

      const schedDep = dep?.scheduledTime?.utc
      const actualDep = depLive ? (dep?.runwayTime?.utc ?? dep?.revisedTime?.utc) : undefined
      const schedArr = arr?.scheduledTime?.utc
      const actualArr = arrLive ? (arr?.runwayTime?.utc ?? arr?.revisedTime?.utc) : undefined

      // Derive operating date from scheduled departure (or arrival fallback)
      const opDate = (schedDep ?? schedArr ?? today).slice(0, 10)

      return {
        callsign: f.callSign!,
        operating_date: opDate,
        flight_number: f.number ?? null,
        dep_iata: dep?.airport?.iata ?? null,
        arr_iata: arr?.airport?.iata ?? null,
        dep_icao: dep?.airport?.icao ?? null,
        arr_icao: arr?.airport?.icao ?? null,
        status: f.status ?? 'Unknown',
        scheduled_dep_utc: schedDep ? new Date(schedDep).toISOString() : null,
        actual_dep_utc: actualDep ? new Date(actualDep).toISOString() : null,
        scheduled_arr_utc: schedArr ? new Date(schedArr).toISOString() : null,
        actual_arr_utc: actualArr ? new Date(actualArr).toISOString() : null,
        dep_delay_min: delayMin(schedDep, actualDep),
        arr_delay_min: delayMin(schedArr, actualArr),
        aircraft_reg: f.aircraft?.reg ?? null,
        aircraft_type: f.aircraft?.model ?? null,
        airline_name: f.airline?.name ?? null,
        dep_quality: dep?.quality ?? [],
        arr_quality: arr?.quality ?? [],
        last_synced_at: new Date().toISOString(),
      }
    })

  if (rows.length > 0) {
    await sb('/flight_status', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    })
  }

  const departed = rows.filter(r => r.status === 'Departed').length
  const arrived  = rows.filter(r => r.status === 'Arrived').length
  const withPos  = rows.filter(r => r.actual_dep_utc).length

  return NextResponse.json({
    ok: true,
    synced: rows.length,
    departed,
    arrived,
    with_actual_dep: withPos,
  })
}

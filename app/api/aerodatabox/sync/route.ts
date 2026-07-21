import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 55

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

function adb(path: string) {
  return fetch(`${ADB_BASE}${path}`, {
    headers: { 'x-api-market-key': ADB_KEY },
    signal: AbortSignal.timeout(12_000),
  })
}

function delayMin(scheduled: string | undefined, actual: string | undefined): number | null {
  if (!scheduled || !actual) return null
  const diff = (new Date(actual).getTime() - new Date(scheduled).getTime()) / 60_000
  return Math.round(diff)
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

function resolveStatus(raw: unknown): string {
  if (typeof raw === 'number') return ADB_STATUS[raw] ?? 'Unknown'
  if (typeof raw === 'string') {
    const n = Number(raw)
    if (!isNaN(n) && raw.trim() !== '') return ADB_STATUS[n] ?? raw
    return raw
  }
  return 'Unknown'
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
        status: resolveStatus(f.status),
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

  // ── Second pass: look up active FYC* (Fly Cham) flights by callsign ──────────
  // FR24 doesn't carry XH/FYC flights. For every FYC flight that should have
  // landed in the last 10 hours but has no actual_arr_utc, we call ADB directly.
  // Source 1: flight_status rows missing arrival (flight already known to system)
  // Source 2: flight_schedule entries whose arr_time_utc falls in the window
  //           (catches flights that never got a flight_status row yet)
  let fycSynced = 0
  try {
    const now2      = new Date()
    const yesterday = new Date(now2.getTime() - 86_400_000).toISOString().slice(0, 10)

    // Source 1: known rows without arrival
    const fsRes = await fetch(
      `${SB_URL}/rest/v1/flight_status?callsign=like.FYC*&operating_date=gte.${yesterday}&actual_arr_utc=is.null&select=callsign,operating_date`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, signal: AbortSignal.timeout(8_000) },
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const knownFyc: { callsign: string; operating_date: string }[] = fsRes.ok ? await fsRes.json() : []

    // Source 2: FYC flights active per schedule — DB handles midnight wraparound
    const schedRes = await fetch(
      `${SB_URL}/rest/v1/rpc/get_active_fyc_callsigns`,
      {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours_back: 12 }),
        signal: AbortSignal.timeout(8_000),
      },
    )
    const schedFyc: { broadcast_callsign: string; operating_date: string }[] = schedRes.ok ? await schedRes.json() : []

    // Merge: union of known rows (no arrival) + schedule-derived, deduplicated
    const seen = new Set(knownFyc.map(f => f.callsign))
    const toCheck: { callsign: string; operating_date: string }[] = [...knownFyc]
    for (const s of schedFyc) {
      if (!seen.has(s.broadcast_callsign)) {
        seen.add(s.broadcast_callsign)
        toCheck.push({ callsign: s.broadcast_callsign, operating_date: s.operating_date })
      }
    }

    for (const { callsign, operating_date } of toCheck) {
      try {
        const flRes = await adb(`/flights/callsign/${encodeURIComponent(callsign)}`)
        if (!flRes.ok) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const flData: any = await flRes.json()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const flList: any[] = Array.isArray(flData) ? flData : (flData ? [flData] : [])
        for (const f of flList) {
          const dep = f.departure ?? {}
          const arr = f.arrival ?? {}
          const arrLive = hasLive(arr.quality)
          const actualArr = arrLive ? (arr.runwayTime?.utc ?? arr.revisedTime?.utc) : undefined
          if (!actualArr) continue
          // Reject stale ADB responses: arrival must be within the last 24 hours
          if (now2.getTime() - new Date(actualArr).getTime() > 24 * 3_600_000) continue

          await sb('/flight_status', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify([{
              callsign,
              operating_date,
              arr_iata:       arr.airport?.iata ?? null,
              arr_icao:       arr.airport?.icao ?? null,
              dep_iata:       dep.airport?.iata ?? null,
              status:         f.status ?? 'Arrived',
              actual_arr_utc: new Date(actualArr).toISOString(),
              arr_delay_min:  delayMin(arr.scheduledTime?.utc, actualArr),
              arr_quality:    arr.quality ?? [],
              last_synced_at: now2.toISOString(),
            }]),
          })
          fycSynced++
        }
      } catch { /* skip this callsign, continue with others */ }
    }
  } catch { /* non-fatal: second pass failures don't break the response */ }

  return NextResponse.json({
    ok: true,
    synced: rows.length,
    departed,
    arrived,
    with_actual_dep: withPos,
    fyc_arrival_synced: fycSynced,
  })
}

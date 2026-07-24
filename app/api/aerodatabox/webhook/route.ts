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
  7:  'Delayed',
  8:  'Approaching',
  9:  'Arrived',
  10: 'Cancelled',
  11: 'Diverted',
  12: 'Cancelled',   // CanceledUncertain — treat as Cancelled
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
  const buildMap = (rows: { iata_number: string; broadcast_callsign: string }[]) => {
    const map: Record<string, string> = {}
    for (const r of rows) {
      if (r.iata_number && r.broadcast_callsign) map[r.iata_number.toUpperCase()] = r.broadcast_callsign
    }
    return map
  }

  // Primary: RPC (joins flight_lookup + route_master, returns active Syria pairs)
  try {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/get_syria_flight_pairs`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5_000),
    })
    if (res.ok) {
      const rows: { iata_number: string; broadcast_callsign: string }[] = await res.json()
      if (rows.length > 0) return buildMap(rows)
    }
  } catch { /* fall through to fallback */ }

  // Fallback: direct flight_lookup query — used when RPC times out or returns empty.
  // This ensures callsign resolution still works for flights like FZ1847 whose
  // cancellation webhooks arrive with no callSign field.
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/flight_lookup?select=iata_number,broadcast_callsign&broadcast_callsign=not.is.null`,
      {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
        signal: AbortSignal.timeout(5_000),
      },
    )
    if (res.ok) {
      const rows: { iata_number: string; broadcast_callsign: string }[] = await res.json()
      return buildMap(rows)
    }
  } catch { /* give up */ }

  return {}
}

interface StatusRow {
  callsign:          string
  operating_date:    string
  scheduled_dep_utc: string | null
  revised_dep_utc:   string | null
  scheduled_arr_utc: string | null
  revised_arr_utc:   string | null
}

// For future-dated webhook rows: patch flight_instance std/sta if ADB times
// differ by ≥15 min, and write a log entry for each change.
async function syncFutureInstances(rows: StatusRow[]) {
  const today = new Date().toISOString().slice(0, 10)
  const future = rows.filter(r => r.operating_date > today)
  if (future.length === 0) return

  // Step 1: callsign → flight_id
  const callsigns = [...new Set(future.map(r => r.callsign))]
  const flRes = await fetch(
    `${SB_URL}/rest/v1/flight_lookup?select=id,broadcast_callsign&broadcast_callsign=in.(${callsigns.join(',')})`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  )
  if (!flRes.ok) return
  const flRows: { id: number; broadcast_callsign: string }[] = await flRes.json()
  const callsignToFlightId: Record<string, number> = {}
  for (const r of flRows) callsignToFlightId[r.broadcast_callsign] = r.id

  const flightIds = Object.values(callsignToFlightId)
  if (flightIds.length === 0) return

  // Step 2: load matching flight_instances
  const dates = [...new Set(future.map(r => r.operating_date))]
  const fiRes = await fetch(
    `${SB_URL}/rest/v1/flight_instance?select=id,flight_id,flight_date,std,sta` +
    `&flight_id=in.(${flightIds.join(',')})&flight_date=in.(${dates.join(',')})`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  )
  if (!fiRes.ok) return
  const instances: { id: number; flight_id: number; flight_date: string; std: string | null; sta: string | null }[] =
    await fiRes.json()

  const instanceMap: Record<string, typeof instances[0]> = {}
  for (const inst of instances) instanceMap[`${inst.flight_id}|${inst.flight_date}`] = inst

  // Step 3: compare and patch
  const now = new Date().toISOString()
  for (const row of future) {
    const flightId = callsignToFlightId[row.callsign]
    if (!flightId) continue
    const inst = instanceMap[`${flightId}|${row.operating_date}`]
    if (!inst) continue

    const effDep = row.revised_dep_utc ?? row.scheduled_dep_utc
    const effArr = row.revised_arr_utc ?? row.scheduled_arr_utc

    const changes: Array<{ field: 'std' | 'sta'; old_utc: string | null; new_utc: string; diff_min: number }> = []

    if (effDep && inst.std) {
      const diffMin = Math.round((new Date(effDep).getTime() - new Date(inst.std).getTime()) / 60_000)
      if (Math.abs(diffMin) >= 5) changes.push({ field: 'std', old_utc: inst.std, new_utc: effDep, diff_min: diffMin })
    }

    if (effArr && inst.sta) {
      const diffMin = Math.round((new Date(effArr).getTime() - new Date(inst.sta).getTime()) / 60_000)
      if (Math.abs(diffMin) >= 5) changes.push({ field: 'sta', old_utc: inst.sta, new_utc: effArr, diff_min: diffMin })
    }

    if (changes.length === 0) continue

    // Patch flight_instance (only std/sta — never touches ata/atd/status)
    const patch: Record<string, string> = {}
    for (const c of changes) patch[c.field] = c.new_utc
    await fetch(`${SB_URL}/rest/v1/flight_instance?id=eq.${inst.id}`, {
      method: 'PATCH',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(patch),
    })

    // Log every change
    await sb('/instance_time_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(
        changes.map(c => ({
          flight_instance_id: inst.id,
          callsign:           row.callsign,
          flight_date:        row.operating_date,
          field:              c.field,
          old_utc:            c.old_utc,
          new_utc:            c.new_utc,
          diff_min:           c.diff_min,
          source:             'adb_webhook',
          logged_at:          now,
        })),
      ),
    })
  }
}

// Normalise a single AeroDataBox flight object into a flight_status row
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRow(f: any, iataToCallsign: Record<string, string>): StatusRow | null {
  // ADB webhook payloads sometimes omit callSign and only send number (IATA).
  const callSign: string | undefined =
    f.callSign ?? iataToCallsign[(f.number ?? '').toString().toUpperCase().replace(/\s+/g, '')] ?? undefined
  if (!callSign) return null

  const dep = f.departure ?? {}
  const arr = f.arrival ?? {}
  const depLive = hasLive(dep.quality)
  const arrLive = hasLive(arr.quality)

  const schedDep = dep.scheduledTime?.utc
  // runwayTime is the actual wheels-off/on — always trust it when present.
  // revisedTime is estimated/revised scheduled time — only treat as "actual" with live ADS-B quality.
  const actualDep = dep.runwayTime?.utc ?? (depLive ? dep.revisedTime?.utc : undefined)
  const schedArr  = arr.scheduledTime?.utc
  const actualArr = arr.runwayTime?.utc ?? (arrLive ? arr.revisedTime?.utc : undefined)

  const opDate = (schedDep ?? schedArr ?? new Date().toISOString()).slice(0, 10)

  const revisedDep = dep.revisedTime?.utc
  const revisedArr = arr.revisedTime?.utc

  const rawStatus = resolveStatus(f.status)
  // Safety net: actual arrival time is ground truth regardless of status code.
  const status = actualArr ? 'Arrived' : rawStatus

  // Drop pre-departure gate ops (Expected/CheckIn/Boarding/GateClosed) that arrive
  // after scheduled arrival — ADB sometimes batches stale ground ops hours late,
  // which would regress status and reset last_synced_at, deferring the cron.
  const PRE_DEP_STATUSES = new Set(['Expected', 'CheckIn', 'Boarding', 'GateClosed'])
  if (PRE_DEP_STATUSES.has(status) && schedArr && new Date() > new Date(schedArr)) {
    return null
  }

  return {
    callsign:          callSign,
    operating_date:    opDate,
    flight_number:     f.number ?? null,
    dep_iata:          dep.airport?.iata ?? null,
    arr_iata:          arr.airport?.iata ?? null,
    dep_icao:          dep.airport?.icao ?? null,
    arr_icao:          arr.airport?.icao ?? null,
    status,
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
  } as StatusRow & Record<string, unknown>
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
  const rows = flights.map(f => toRow(f, iataToCallsign)).filter(Boolean) as StatusRow[]

  if (rows.length > 0) {
    await sb('/flight_status', {
      method: 'POST',
      body: JSON.stringify(rows),
    })

    // Patch future flight_instances whose std/sta diverge from ADB by ≥15 min
    try {
      await syncFutureInstances(rows)
    } catch { /* non-fatal — status write already succeeded */ }
  }

  // Log every webhook hit — use resolved callsign so NULL doesn't obscure which flight it was
  try {
    const firstFlight = flights[0]
    const resolvedCallsign = rows[0]?.callsign ?? firstFlight?.callSign ?? null
    await sb('/webhook_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        callsign:   resolvedCallsign,
        flight_num: firstFlight?.number   ?? null,
        status:     firstFlight ? String(firstFlight.status ?? '') : null,
        credits:    remainingCredits != null ? Math.round(remainingCredits) : null,
        payload,
      }),
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ ok: true, processed: rows.length, remainingCredits })
}

import { NextResponse } from 'next/server'

export const dynamic   = 'force-dynamic'
export const maxDuration = 45

const AE_KEY  = process.env.AVIATION_EDGE_KEY!
const AE_BASE = 'https://aviation-edge.com/v2/public/flights'
const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_ANON_KEY!

const SB_HEADERS = {
  apikey:         SB_KEY,
  Authorization:  `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
}

const QUERIES = [
  { airport: 'DAM', direction: 'dep', param: 'depIata', value: 'DAM' },
  { airport: 'DAM', direction: 'arr', param: 'arrIata', value: 'DAM' },
  { airport: 'ALP', direction: 'dep', param: 'depIata', value: 'ALP' },
  { airport: 'ALP', direction: 'arr', param: 'arrIata', value: 'ALP' },
]

// Statuses that mean PF already has a good signal — don't overwrite with AE tracking
const TERMINAL = new Set(['En Route', 'Approaching', 'Departed', 'Landed', 'Arrived', 'Cancelled'])

interface AEFlight {
  aircraft?:  { regNumber?: string; icaoCode?: string }
  airline?:   { icaoCode?: string }
  arrival?:   { iataCode?: string }
  departure?: { iataCode?: string }
  flight?:    { iataNumber?: string; icaoNumber?: string }
  geography?: { altitude?: number }
  status?:    string
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

// Cross-reference AE live flights against our schedule and mark untracked flights as En Route.
// Runs after each cron cycle to fill gaps for airlines PlaneFinder doesn't cover (e.g. Jazeera).
async function processActiveFlights(flights: AEFlight[], now: Date, summary: string[]) {
  // Build icaoNumber → AEFlight map (icaoNumber = broadcast_callsign in our DB, e.g. JZR174)
  const aeByCallsign = new Map<string, AEFlight>()
  for (const f of flights) {
    const cs = f.flight?.icaoNumber
    if (cs) aeByCallsign.set(cs, f)
  }
  if (aeByCallsign.size === 0) return

  const callsigns = [...aeByCallsign.keys()]
  const yesterday = new Date(now.getTime() - 24 * 3600_000).toISOString().slice(0, 10)
  const minus3h   = new Date(now.getTime() - 3 * 3600_000).toISOString()

  // 1. Resolve flight IDs for callsigns AE returned
  const flRes = await fetch(
    `${SB_URL}/rest/v1/flight_lookup?select=id,broadcast_callsign` +
    `&broadcast_callsign=in.(${callsigns.join(',')})`,
    { headers: SB_HEADERS },
  )
  if (!flRes.ok) return
  const flRows: { id: number; broadcast_callsign: string }[] = await flRes.json()
  if (flRows.length === 0) return

  const flightIdToCallsign: Record<number, string> = {}
  for (const r of flRows) flightIdToCallsign[r.id] = r.broadcast_callsign
  const flightIds = Object.keys(flightIdToCallsign)

  // 2. Active flight_instances: departed (std ≤ now) but not yet arrived (sta ≥ now - 3h)
  const fiRes = await fetch(
    `${SB_URL}/rest/v1/flight_instance` +
    `?select=flight_id,flight_date,std,sta,dep_iata,arr_iata` +
    `&flight_id=in.(${flightIds.join(',')})` +
    `&flight_date=gte.${yesterday}` +
    `&std=lte.${now.toISOString()}` +
    `&sta=gte.${minus3h}`,
    { headers: SB_HEADERS },
  )
  if (!fiRes.ok) return
  const instances: {
    flight_id: number; flight_date: string; std: string; sta: string
    dep_iata: string | null; arr_iata: string | null
  }[] = await fiRes.json()
  if (instances.length === 0) return

  // 3. Current flight_status — skip anything already tracked by PF or ADB
  const activeCallsigns = [...new Set(
    instances.map(i => flightIdToCallsign[i.flight_id]).filter(Boolean),
  )]
  const activeDates = [...new Set(instances.map(i => i.flight_date))]
  const fsRes = await fetch(
    `${SB_URL}/rest/v1/flight_status?select=callsign,operating_date,status` +
    `&callsign=in.(${activeCallsigns.join(',')})` +
    `&operating_date=in.(${activeDates.join(',')})`,
    { headers: SB_HEADERS },
  )
  const fsRows: { callsign: string; operating_date: string; status: string | null }[] =
    fsRes.ok ? await fsRes.json() : []
  const statusMap = new Map(fsRows.map(r => [`${r.callsign}_${r.operating_date}`, r.status]))

  // 4. Upsert En Route for flights AE sees that we haven't tracked yet
  const upserts: Record<string, unknown>[] = []
  for (const inst of instances) {
    const callsign = flightIdToCallsign[inst.flight_id]
    if (!callsign) continue
    const current = statusMap.get(`${callsign}_${inst.flight_date}`) ?? null
    if (current && TERMINAL.has(current)) continue  // PF/ADB already on it

    const ae = aeByCallsign.get(callsign)
    if (!ae) continue

    upserts.push({
      callsign,
      operating_date:    inst.flight_date,
      status:            'En Route',
      dep_iata:          ae.departure?.iataCode ?? inst.dep_iata,
      arr_iata:          ae.arrival?.iataCode   ?? inst.arr_iata,
      airline_icao:      ae.airline?.icaoCode   ?? callsign.slice(0, 3),
      aircraft_reg:      ae.aircraft?.regNumber ?? null,
      aircraft_type:     ae.aircraft?.icaoCode  ?? null,
      scheduled_dep_utc: inst.std,
      scheduled_arr_utc: inst.sta,
      last_synced_at:    now.toISOString(),
    })
    summary.push(`ae-match: ${callsign} → En Route (was: ${current ?? 'none'})`)
  }

  if (upserts.length === 0) return

  await fetch(`${SB_URL}/rest/v1/flight_status`, {
    method:  'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify(upserts),
  }).catch(e => console.error('[ae-tracking] status upsert failed:', e))
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  if (!AE_KEY) {
    return NextResponse.json({ ok: false, error: 'AVIATION_EDGE_KEY not set' }, { status: 503 })
  }

  const now    = new Date()
  const ran_at = now.toISOString()
  const rows: object[]    = []
  const summary: string[] = []
  const allFlights: AEFlight[] = []

  for (const q of QUERIES) {
    try {
      const url = `${AE_BASE}?key=${AE_KEY}&${q.param}=${q.value}`
      const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })

      if (!res.ok) {
        summary.push(`${q.direction}/${q.airport}: HTTP ${res.status}`)
        await sleep(1500)
        continue
      }

      const data: AEFlight[] = await res.json()
      const flights = Array.isArray(data) ? data : []

      rows.push({
        ran_at,
        airport:      q.airport,
        direction:    q.direction,
        flight_count: flights.length,
        payload:      flights,
      })

      allFlights.push(...flights)
      summary.push(`${q.direction}/${q.airport}: ${flights.length} flights`)
    } catch (e) {
      summary.push(`${q.direction}/${q.airport}: error — ${String(e)}`)
    }

    await sleep(1500)
  }

  // Write raw snapshots
  if (rows.length > 0) {
    await fetch(`${SB_URL}/rest/v1/ae_tracking_log`, {
      method:  'POST',
      headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
      body:    JSON.stringify(rows),
    }).catch(e => console.error('[ae-tracking] DB write failed:', e))
  }

  // Deduplicate by icaoNumber and update flight_status for untracked active flights
  const seen = new Set<string>()
  const uniqueFlights = allFlights.filter(f => {
    const key = f.flight?.icaoNumber
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
  await processActiveFlights(uniqueFlights, now, summary).catch(
    e => console.error('[ae-tracking] processActiveFlights failed:', e),
  )

  return NextResponse.json({ ok: true, ran_at, summary, rows_written: rows.length })
}

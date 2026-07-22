import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const SY_AIRPORTS = new Set(['DAM', 'ALP'])

async function sb(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string>),
    },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

// Syria is UTC+3; convert local HH:MM to UTC HH:MM (wraps around midnight)
function toUtc(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const utcMin = (((h * 60 + m) - 180) % 1440 + 1440) % 1440
  return `${String(Math.floor(utcMin / 60)).padStart(2, '0')}:${String(utcMin % 60).padStart(2, '0')}`
}

function hhmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// Combine a date (YYYY-MM-DD) and UTC HH:MM[:SS] time into an ISO timestamp.
// If stdRef is given and the result precedes it, advances by 1 day (next-day arrival).
function toTimestamp(date: string, timeUtc: string | null, stdRef?: string | null): string | null {
  if (!timeUtc) return null
  const hhmm = timeUtc.slice(0, 5)
  const ts = new Date(`${date}T${hhmm}:00Z`)
  if (stdRef && ts.toISOString() < stdRef) ts.setUTCDate(ts.getUTCDate() + 1)
  return ts.toISOString()
}

type RawRow = {
  carrier: string; carrier_icao: string | null; flightnumber: number
  iata_from: string; iata_to: string
  dep_time_local: string | null; arr_time_local: string | null
  direction: string; status: string; airline_name: string | null
  schedule_date: string
}

// Process one date: ensure master data → upsert route_master → create flight_instance rows
async function processDate(airport: string, date: string, rawRows: RawRow[]) {
  const dow = DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()]

  // ── 2. Ensure airlines master data ─────────────────────────────────────
  const uniqueCarriers = [...new Set(rawRows.map(r => r.carrier))]

  const existingAirlines: { id: number; iata: string; icao: string | null }[] =
    await sb(`/airlines?iata=in.(${uniqueCarriers.join(',')})&select=id,iata,icao`)
  const airlineByIata = new Map(existingAirlines.map(a => [a.iata, a]))

  const missingAirlineRows: { iata: string; icao: string | null; name_en: string | null }[] = []
  for (const r of rawRows) {
    if (!airlineByIata.has(r.carrier) && !missingAirlineRows.find(x => x.iata === r.carrier)) {
      missingAirlineRows.push({ iata: r.carrier, icao: r.carrier_icao ?? null, name_en: r.airline_name ?? null })
    }
  }

  let airlinesAdded = 0
  if (missingAirlineRows.length) {
    const inserted: { id: number; iata: string; icao: string | null }[] = await sb('/airlines', {
      method:  'POST',
      headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
      body:    JSON.stringify(missingAirlineRows),
    })
    for (const a of (inserted ?? [])) airlineByIata.set(a.iata, a)
    airlinesAdded = missingAirlineRows.length
  }

  // ── 3. Ensure flight_lookup entries ─────────────────────────────────────
  const iataNumbers = [...new Set(rawRows.map(r => `${r.carrier}${r.flightnumber}`))]

  const existingLookup: { id: number; iata_number: string; broadcast_callsign: string | null }[] =
    await sb(`/flight_lookup?iata_number=in.(${iataNumbers.join(',')})&select=id,iata_number,broadcast_callsign`)
  const lookupByIata = new Map(existingLookup.map(l => [l.iata_number, l]))

  const missingLookupRows: { airline_id: number | undefined; iata_number: string; broadcast_callsign: string | null; source: string }[] = []
  for (const iataNum of iataNumbers) {
    if (!lookupByIata.has(iataNum)) {
      const raw = rawRows.find(r => `${r.carrier}${r.flightnumber}` === iataNum)!
      const airline = airlineByIata.get(raw.carrier)
      const broadcast = raw.carrier_icao ? `${raw.carrier_icao}${raw.flightnumber}` : null
      missingLookupRows.push({ airline_id: airline?.id, iata_number: iataNum, broadcast_callsign: broadcast, source: 'damairport' })
    }
  }

  let lookupAdded = 0
  if (missingLookupRows.length) {
    const inserted: { id: number; iata_number: string; broadcast_callsign: string | null }[] = await sb('/flight_lookup', {
      method:  'POST',
      headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
      body:    JSON.stringify(missingLookupRows),
    })
    for (const l of (inserted ?? [])) lookupByIata.set(l.iata_number, l)
    lookupAdded = missingLookupRows.length
  }

  // ── 4. Upsert route_master ───────────────────────────────────────────────
  const flightIds = [...new Set([...lookupByIata.values()].map(l => l.id))]
  const existingSchedule: {
    id: number; flight_id: number; dep_iata: string; arr_iata: string
    dep_time: string | null; arr_time: string | null; days_of_week: string[]
  }[] = flightIds.length
    ? await sb(`/route_master?flight_id=in.(${flightIds.join(',')})&source=eq.damairport` +
               `&select=id,flight_id,dep_iata,arr_iata,dep_time,arr_time,days_of_week`)
    : []

  // Key uses the Syria-side time only (arr for arrivals, dep for departures) — stable after fill adds the other side
  const schedKey = (r: { flight_id: number; dep_iata: string; arr_iata: string; dep_time: string | null; arr_time: string | null }) => {
    const authTime = SY_AIRPORTS.has(r.arr_iata) ? r.arr_time : r.dep_time
    return `${r.flight_id}|${r.dep_iata}|${r.arr_iata}|${(authTime ?? '').slice(0, 5)}`
  }
  const schedMap = new Map(existingSchedule.map(r => [schedKey(r), r]))

  // Index existing rows by flight_id+route for drift detection
  type ExistingRow = typeof existingSchedule[number]
  const byRoute = new Map<string, ExistingRow[]>()
  for (const r of existingSchedule) {
    const rk = `${r.flight_id}|${r.dep_iata}|${r.arr_iata}`
    ;(byRoute.get(rk) ?? byRoute.set(rk, []).get(rk)!).push(r)
  }

  const toInsert: object[] = []
  const toUpdate: { id: number; days_of_week: string[]; dep_time?: string; arr_time?: string; dep_time_utc?: string; arr_time_utc?: string }[] = []

  for (const raw of rawRows) {
    const iataNum = `${raw.carrier}${raw.flightnumber}`
    const lookup  = lookupByIata.get(iataNum)
    if (!lookup) continue

    const depTime = raw.dep_time_local?.slice(0, 5) ?? null
    const arrTime = raw.arr_time_local?.slice(0, 5) ?? null
    const authTime = SY_AIRPORTS.has(raw.iata_to) ? arrTime : depTime
    const key      = `${lookup.id}|${raw.iata_from}|${raw.iata_to}|${authTime ?? ''}`
    const existing = schedMap.get(key)

    if (existing) {
      if (!existing.days_of_week?.includes(dow)) {
        toUpdate.push({
          id:           existing.id,
          days_of_week: [...new Set([...(existing.days_of_week ?? []), dow])].sort(),
        })
      }
    } else {
      // Check for schedule drift: same flight+route with Syria-side time within 30 min
      const routeKey  = `${lookup.id}|${raw.iata_from}|${raw.iata_to}`
      const authMin   = authTime ? hhmToMin(authTime) : null
      const driftMatch = authMin !== null
        ? (byRoute.get(routeKey) ?? []).find(r => {
            const existAuth = SY_AIRPORTS.has(r.arr_iata) ? r.arr_time : r.dep_time
            if (!existAuth) return false
            const diff = Math.abs(hhmToMin(existAuth.slice(0, 5)) - authMin)
            return Math.min(diff, 1440 - diff) <= 30
          })
        : undefined

      if (driftMatch) {
        const newDow = [...new Set([...(driftMatch.days_of_week ?? []), dow])].sort()
        toUpdate.push({
          id:           driftMatch.id,
          days_of_week: newDow,
          ...(SY_AIRPORTS.has(raw.iata_to)
            ? { arr_time: arrTime!, arr_time_utc: toUtc(arrTime!) + ':00' }
            : { dep_time: depTime!, dep_time_utc: toUtc(depTime!) + ':00' }),
        })
        schedMap.delete(schedKey(driftMatch))
        schedMap.set(key, driftMatch)
      } else {
        toInsert.push({
          flight_id:    lookup.id,
          airline_id:   airlineByIata.get(raw.carrier)?.id,
          dep_iata:     raw.iata_from,
          arr_iata:     raw.iata_to,
          dep_time:     depTime,
          arr_time:     arrTime,
          dep_time_utc: depTime ? toUtc(depTime) : null,
          arr_time_utc: arrTime ? toUtc(arrTime) : null,
          days_of_week: [dow],
          source:       'damairport',
          data_updated: new Date().toISOString(),
        })
      }
    }
  }

  if (toInsert.length) {
    await sb('/route_master', {
      method:  'POST',
      headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
      body:    JSON.stringify(toInsert),
    })
  }

  if (toUpdate.length) {
    await Promise.all(
      toUpdate.map(({ id, ...fields }) =>
        sb(`/route_master?id=eq.${id}`, {
          method:  'PATCH',
          headers: { Prefer: 'return=minimal' },
          body:    JSON.stringify({ ...fields, data_updated: new Date().toISOString() }),
        })
      )
    )
  }

  // ── 5. Create flight_instance rows for this date ─────────────────────────
  // Re-read route_master for final dep/arr UTC times (just-inserted rows now visible)
  const finalRoutes: {
    id: number; flight_id: number; dep_iata: string; arr_iata: string
    dep_time_utc: string | null; arr_time_utc: string | null
  }[] = flightIds.length
    ? await sb(`/route_master?flight_id=in.(${flightIds.join(',')})&select=id,flight_id,dep_iata,arr_iata,dep_time_utc,arr_time_utc`)
    : []

  const routeByKey = new Map(finalRoutes.map(r => [`${r.flight_id}|${r.dep_iata}|${r.arr_iata}`, r]))

  const instanceRows: object[] = []
  for (const raw of rawRows) {
    const iataNum = `${raw.carrier}${raw.flightnumber}`
    const lookup  = lookupByIata.get(iataNum)
    if (!lookup) continue

    const route = routeByKey.get(`${lookup.id}|${raw.iata_from}|${raw.iata_to}`)
    if (!route?.dep_time_utc) continue  // skip if departure time not yet known; fill will complete it

    const std = toTimestamp(date, route.dep_time_utc)
    const sta = toTimestamp(date, route.arr_time_utc, std)

    instanceRows.push({
      flight_id:   lookup.id,
      route_id:    route.id,
      flight_date: date,
      dep_iata:    raw.iata_from,
      arr_iata:    raw.iata_to,
      std,
      sta,
    })
  }

  let instancesUpserted = 0
  if (instanceRows.length) {
    // merge-duplicates updates route_id/std/sta; leaves atd/ata/status/etd/eta untouched
    await sb('/flight_instance', {
      method:  'POST',
      headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
      body:    JSON.stringify(instanceRows),
    })
    instancesUpserted = instanceRows.length
  }

  const driftCount = toUpdate.filter(u => u.dep_time || u.arr_time).length

  return {
    date,
    dow,
    raw_rows:           rawRows.length,
    airlines_added:     airlinesAdded,
    lookup_added:       lookupAdded,
    routes_inserted:    toInsert.length,
    routes_updated:     toUpdate.length - driftCount,
    routes_drift:       driftCount,
    instances_upserted: instancesUpserted,
  }
}

// POST /api/sync/damairport/ingest?airport=DAM
// Reads ALL dates in schedule_raw → validates master data → upserts route_master → creates flight_instance
export async function GET(req: Request) {
  return POST(req)
}

export async function POST(req: Request) {
  const url     = new URL(req.url)
  const airport = (url.searchParams.get('airport') ?? 'DAM').toUpperCase()

  // ── 1. Read all snapshot rows for this airport (all dates) ──────────────
  const allRaw: RawRow[] = await sb(
    `/schedule_raw?airport_iata=eq.${airport}` +
    `&select=carrier,carrier_icao,flightnumber,iata_from,iata_to,dep_time_local,arr_time_local,direction,status,airline_name,schedule_date` +
    `&order=schedule_date.asc&limit=2000`
  )

  if (!allRaw.length) {
    return NextResponse.json({ ok: false, error: 'No snapshot found — run the sync first' }, { status: 400 })
  }

  // Group by date; process sequentially so date N's route_master inserts are visible when date N+1 runs
  const byDate = new Map<string, RawRow[]>()
  for (const r of allRaw) {
    const rows = byDate.get(r.schedule_date) ?? []
    rows.push(r)
    byDate.set(r.schedule_date, rows)
  }

  const dates = [...byDate.keys()].sort()
  const dateResults = []

  for (const date of dates) {
    dateResults.push(await processDate(airport, date, byDate.get(date)!))
  }

  // Aggregate totals across all dates
  const totals = dateResults.reduce(
    (acc, r) => ({
      airlines_added:     acc.airlines_added     + r.airlines_added,
      lookup_added:       acc.lookup_added       + r.lookup_added,
      routes_inserted:    acc.routes_inserted    + r.routes_inserted,
      routes_updated:     acc.routes_updated     + r.routes_updated,
      routes_drift:       acc.routes_drift       + r.routes_drift,
      instances_upserted: acc.instances_upserted + r.instances_upserted,
    }),
    { airlines_added: 0, lookup_added: 0, routes_inserted: 0, routes_updated: 0, routes_drift: 0, instances_upserted: 0 }
  )

  return NextResponse.json({ ok: true, airport, dates: dateResults, ...totals })
}

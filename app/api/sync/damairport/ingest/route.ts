import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

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

// POST /api/sync/damairport/ingest?date=YYYY-MM-DD&airport=DAM
// Reads schedule_raw snapshot → validates master data → upserts flight_schedule
export async function GET(req: Request) {
  return POST(req)
}

export async function POST(req: Request) {
  const url     = new URL(req.url)
  const date    = url.searchParams.get('date') ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
  const airport = (url.searchParams.get('airport') ?? 'DAM').toUpperCase()
  const dow     = DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()]

  // ── 1. Read snapshot ────────────────────────────────────────────────────────
  const rawRows: {
    carrier: string; carrier_icao: string | null; flightnumber: number
    iata_from: string; iata_to: string
    dep_time_local: string | null; arr_time_local: string | null
    direction: string; status: string; airline_name: string | null
  }[] = await sb(
    `/schedule_raw?schedule_date=eq.${date}&airport_iata=eq.${airport}` +
    `&select=carrier,carrier_icao,flightnumber,iata_from,iata_to,dep_time_local,arr_time_local,direction,status,airline_name`
  )

  if (!rawRows.length) {
    return NextResponse.json({ ok: false, error: 'No snapshot found — run the sync first' }, { status: 400 })
  }

  // ── 2. Ensure airlines master data ─────────────────────────────────────────
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

  // ── 3. Ensure flight_lookup entries ────────────────────────────────────────
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

  // ── 4. Upsert flight_schedule ───────────────────────────────────────────────
  // Fetch existing damairport rows for these flight_ids
  const flightIds = [...new Set([...lookupByIata.values()].map(l => l.id))]
  const existingSchedule: {
    id: number; flight_id: number; dep_iata: string; arr_iata: string
    dep_time: string | null; arr_time: string | null; days_of_week: string[]
  }[] = flightIds.length
    ? await sb(`/flight_schedule?flight_id=in.(${flightIds.join(',')})&source=eq.damairport` +
               `&select=id,flight_id,dep_iata,arr_iata,dep_time,arr_time,days_of_week`)
    : []

  const SY_AIRPORTS = new Set(['DAM', 'ALP'])

  // Key uses the Syria-side time only (arrival time for arrivals, departure for departures).
  // This stays stable after the fill step adds the missing other-side time.
  const schedKey = (r: { flight_id: number; dep_iata: string; arr_iata: string; dep_time: string | null; arr_time: string | null }) => {
    const authTime = SY_AIRPORTS.has(r.arr_iata) ? r.arr_time : r.dep_time
    return `${r.flight_id}|${r.dep_iata}|${r.arr_iata}|${(authTime ?? '').slice(0, 5)}`
  }
  const schedMap = new Map(existingSchedule.map(r => [schedKey(r), r]))

  const toInsert: object[] = []
  const toUpdate: { id: number; days_of_week: string[] }[] = []

  for (const raw of rawRows) {
    const iataNum = `${raw.carrier}${raw.flightnumber}`
    const lookup  = lookupByIata.get(iataNum)
    if (!lookup) continue

    const depTime = raw.dep_time_local?.slice(0, 5) ?? null
    const arrTime = raw.arr_time_local?.slice(0, 5) ?? null
    // Key on the Syria-side time (arr for arrivals, dep for departures)
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
      toInsert.push({
        flight_id:    lookup.id,
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

  if (toInsert.length) {
    await sb('/flight_schedule', {
      method:  'POST',
      headers: { Prefer: 'return=minimal' },
      body:    JSON.stringify(toInsert),
    })
  }

  // PATCH updates in parallel (small N, typically < 10)
  if (toUpdate.length) {
    await Promise.all(
      toUpdate.map(upd =>
        sb(`/flight_schedule?id=eq.${upd.id}`, {
          method:  'PATCH',
          headers: { Prefer: 'return=minimal' },
          body:    JSON.stringify({ days_of_week: upd.days_of_week, data_updated: new Date().toISOString() }),
        })
      )
    )
  }

  return NextResponse.json({
    ok:                true,
    date,
    airport,
    dow,
    raw_rows:          rawRows.length,
    airlines_added:    airlinesAdded,
    lookup_added:      lookupAdded,
    schedule_inserted: toInsert.length,
    schedule_updated:  toUpdate.length,
  })
}

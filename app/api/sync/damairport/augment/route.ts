import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!

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

// Airport coordinates for Haversine distance
const AIRPORT_COORDS: Record<string, [number, number]> = {
  DAM: [33.4115,  36.5156], ALP: [36.1807,  37.2244],
  DXB: [25.2532,  55.3657], SHJ: [25.3286,  55.5172], AUH: [24.4330,  54.6511],
  MCT: [23.5933,  58.2844], IST: [41.2608,  28.7418], SAW: [40.8983,  29.3092],
  AMM: [31.7226,  35.9932], BEY: [33.8209,  35.4883], KWI: [29.2267,  47.9689],
  DOH: [25.2609,  51.6138], BGW: [33.2625,  44.2346], EBL: [36.1776,  43.9631],
  RUH: [24.9578,  46.6989], JED: [21.6796,  39.1565], DMM: [26.4712,  49.7981],
  OTP: [44.5711,  26.0850], MJI: [32.6635,  13.1590], AMS: [52.3086,   4.7639],
  ESB: [40.1282,  32.9951], CAI: [30.1219,  31.4056], NJF: [31.9900,  44.4040],
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

// Convert HH:MM UTC to Syria local (UTC+3)
function utcToSyria(hhmm: string): string {
  const [h, m] = hhmm.slice(0, 5).split(':').map(Number)
  const total = ((h * 60 + m) + 180) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

// GET /api/sync/damairport/augment?date=YYYY-MM-DD&airport=DAM|ALP
// Augments schedule_raw rows with:
//   - dep_time_local (for arrivals) or arr_time_local (for departures) from route_master
//   - duration_min from route_master
//   - distance_km from Haversine between airports
// Run this after each damairport sync.
export async function GET(req: Request) {
  const url = new URL(req.url)
  const date    = url.searchParams.get('date')    ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
  const airport = url.searchParams.get('airport') // optional; if omitted, augments all airports for that date

  // 1. Load schedule_raw rows for this date (and optionally airport)
  const filter = airport ? `&airport_iata=eq.${airport}` : ''
  const rawRows: {
    id: number
    direction: 'arrival' | 'departure'
    carrier: string
    flightnumber: number
    iata_from: string
    iata_to:   string
    dep_time_local: string | null
    arr_time_local: string | null
    duration_min:   number | null
  }[] = await sb(
    `/schedule_raw?schedule_date=eq.${date}${filter}` +
    `&select=id,direction,carrier,flightnumber,iata_from,iata_to,dep_time_local,arr_time_local,duration_min`
  )

  if (!rawRows.length) {
    return NextResponse.json({ ok: true, date, augmented: 0, note: 'No schedule_raw rows for this date' })
  }

  // 2. Build unique iata_numbers and fetch flight_lookup
  const iataNumbers = [...new Set(rawRows.map(r => `${r.carrier}${r.flightnumber}`))]
  // PostgREST IN filter — keep batches under 2000 chars
  const BATCH = 80
  const lookupRows: { id: number; iata_number: string }[] = []
  for (let i = 0; i < iataNumbers.length; i += BATCH) {
    const chunk = iataNumbers.slice(i, i + BATCH)
    const rows = await sb(`/flight_lookup?iata_number=in.(${chunk.join(',')})&select=id,iata_number`)
    lookupRows.push(...(rows ?? []))
  }
  const iataToFlightId = new Map(lookupRows.map(r => [r.iata_number, r.id]))

  // 3. Fetch route_master for those flight_ids
  const flightIds = [...new Set(lookupRows.map(r => r.id))]
  const routeRows: {
    flight_id: number
    dep_iata: string
    arr_iata: string
    dep_time_utc: string
    arr_time_utc: string
    duration_min: number | null
  }[] = flightIds.length
    ? await sb(
        `/route_master?flight_id=in.(${flightIds.join(',')})&active=eq.true` +
        `&select=flight_id,dep_iata,arr_iata,dep_time_utc,arr_time_utc,duration_min`
      )
    : []

  // Index: "flightId|depIata|arrIata" → route row
  // Multiple rotations (different times) for the same flight+route use dep_time as secondary key,
  // but schedule_raw doesn't carry time for the unknown half — so we take the first match.
  const routeMap = new Map<string, typeof routeRows[0]>()
  for (const r of routeRows) {
    const key = `${r.flight_id}|${r.dep_iata}|${r.arr_iata}`
    if (!routeMap.has(key)) routeMap.set(key, r)  // first rotation wins
  }

  // 4. Build patches
  const patches: { id: number; patch: Record<string, unknown> }[] = []
  let noMatch = 0

  for (const row of rawRows) {
    const patch: Record<string, unknown> = {}

    // Distance (independent of route_master match)
    const fromC = AIRPORT_COORDS[row.iata_from]
    const toC   = AIRPORT_COORDS[row.iata_to]
    if (fromC && toC) patch.distance_km = haversineKm(fromC[0], fromC[1], toC[0], toC[1])

    // Route_master lookup
    const flightId = iataToFlightId.get(`${row.carrier}${row.flightnumber}`)
    const route    = flightId ? routeMap.get(`${flightId}|${row.iata_from}|${row.iata_to}`) : null

    if (route) {
      if (route.duration_min && !row.duration_min) patch.duration_min = route.duration_min

      // Fill the missing time half — all schedule_raw times are in Syria local (UTC+3)
      if (row.direction === 'arrival' && !row.dep_time_local && route.dep_time_utc) {
        patch.dep_time_local = utcToSyria(route.dep_time_utc)
      } else if (row.direction === 'departure' && !row.arr_time_local && route.arr_time_utc) {
        patch.arr_time_local = utcToSyria(route.arr_time_utc)
      }
    } else {
      noMatch++
    }

    if (Object.keys(patch).length > 0) patches.push({ id: row.id, patch })
  }

  // 5. Apply patches
  if (patches.length > 0) {
    await Promise.all(
      patches.map(({ id, patch }) =>
        sb(`/schedule_raw?id=eq.${id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(patch),
        })
      )
    )
  }

  return NextResponse.json({
    ok:        true,
    date,
    rows:      rawRows.length,
    augmented: patches.filter(p => Object.keys(p.patch).length > (p.patch.distance_km !== undefined ? 1 : 0)).length,
    distances: patches.filter(p => p.patch.distance_km !== undefined).length,
    no_match:  noMatch,
  })
}

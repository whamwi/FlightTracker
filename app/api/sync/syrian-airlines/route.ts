import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const SYR_API = 'https://api-v2.syrlines.com'

// Local UTC offsets for airports we operate (summer/DST aware for Jul–Aug)
const TZ_OFFSET: Record<string, number> = {
  DAM: 3, ALP: 3,                    // Syria UTC+3
  DXB: 4, AUH: 4, SHJ: 4, MCT: 4,   // Gulf UTC+4
  DOH: 3, KWI: 3,                    // Qatar/Kuwait UTC+3
  JED: 3, RUH: 3, MED: 3, DMM: 3,   // Saudi UTC+3
  AMM: 3, BGW: 3, EBL: 3,           // Jordan/Iraq UTC+3
  IST: 3,                            // Turkey UTC+3
  AMS: 2,                            // Netherlands CEST UTC+2 (summer)
  OTP: 3,                            // Romania EEST UTC+3 (summer)
}

// Syrian Airlines API day numbering: 1=Sun, 2=Mon, 3=Tue, 4=Wed, 5=Thu, 6=Fri, 7=Sat
// JS getDay(): 0=Sun, 1=Mon … 6=Sat
const SYR_TO_JS_DAY: Record<number, number> = { 1:0, 2:1, 3:2, 4:3, 5:4, 6:5, 7:6 }

// Route_master day names
const JS_TO_RM_DAY = ['sun','mon','tue','wed','thu','fri','sat']

interface SyrRoute {
  departureAirport: string
  arrivalAirport: string
  departureToArrivalDays: number[]
  arrivalToDepartureDays: number[]
}

interface SyrFlight {
  flightNumber: string
  departureAirport: string
  arrivalAirport: string
  departureDateTime: string  // local at dep airport, no TZ
  arrivalDateTime: string    // local at arr airport, no TZ
  duration: string
}

interface RmRow {
  id: number
  flight_id: number
  dep_iata: string
  arr_iata: string
  dep_time: string | null
  arr_time: string | null
  dep_time_utc: string | null
  arr_time_utc: string | null
  days_of_week: string[]
  source: string
  iata_number: string
  broadcast_callsign: string
}

function localToUtc(localTime: string, airportCode: string): string | null {
  const offset = TZ_OFFSET[airportCode]
  if (offset === undefined) return null
  const [h, m] = localTime.split('T')[1].split(':').map(Number)
  const utcH = ((h - offset) % 24 + 24) % 24
  return `${String(utcH).padStart(2,'0')}:${String(m).padStart(2,'0')}`
}

function utcTimeStr(iso: string): string {
  return iso.slice(11, 16)
}

// Find next date matching a JS day-of-week (0=Sun … 6=Sat) at or after today
function nextDate(jsDow: number): string {
  const now = new Date()
  // Use Syria date (UTC+3)
  const syriaDate = new Date(now.getTime() + 3 * 3600 * 1000)
  const d = new Date(syriaDate.toISOString().slice(0, 10) + 'T00:00:00Z')
  const diff = (jsDow - d.getUTCDay() + 7) % 7 || 7
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().slice(0, 10)
}

async function fetchRoutes(): Promise<SyrRoute[]> {
  const res = await fetch(`${SYR_API}/api/reservations/flight-days`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`flight-days: ${res.status}`)
  const json = await res.json()
  return json.data ?? []
}

async function fetchFlightTime(
  depIata: string,
  arrIata: string,
  date: string,
): Promise<SyrFlight | null> {
  const res = await fetch(`${SYR_API}/api/reservations/available-flights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      departureAirport: depIata,
      arrivalAirport:   arrIata,
      departureDate:    date,
      returnDate:       '',
      numberOfAdults:   1,
      numberOfChildren: 0,
      numberOfInfants:  0,
      classType:        'Economy',
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return null
  const json = await res.json()
  const flight = json.data?.[0]?.flights?.[0]
  return flight ?? null
}

async function fetchRouteMaster(): Promise<RmRow[]> {
  const res = await fetch(
    `${SB_URL}/rest/v1/route_master?select=id,flight_id,dep_iata,arr_iata,dep_time,arr_time,dep_time_utc,arr_time_utc,days_of_week,source,flight_lookup(iata_number,broadcast_callsign)`,
    {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!res.ok) throw new Error(`route_master: ${res.status}`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await res.json()
  return rows.map(r => ({
    ...r,
    iata_number:       r.flight_lookup?.iata_number ?? null,
    broadcast_callsign: r.flight_lookup?.broadcast_callsign ?? null,
  }))
}

export async function GET() {
  const [syrRoutes, rmRows] = await Promise.all([fetchRoutes(), fetchRouteMaster()])

  // Map route_master by "dep_iata|arr_iata" for fast lookup
  const rmByRoute = new Map<string, RmRow[]>()
  for (const r of rmRows) {
    const key = `${r.dep_iata}|${r.arr_iata}`
    if (!rmByRoute.has(key)) rmByRoute.set(key, [])
    rmByRoute.get(key)!.push(r)
  }

  const results: object[] = []

  for (const route of syrRoutes) {
    const { departureAirport: dep, arrivalAirport: arr, departureToArrivalDays: days } = route

    if (!days.length) continue

    // Pick the first operating day to sample the time
    const jsDow = SYR_TO_JS_DAY[days[0]]
    const sampleDate = nextDate(jsDow)

    const flight = await fetchFlightTime(dep, arr, sampleDate)

    const syrDepLocal  = flight ? utcTimeStr(flight.departureDateTime) : null
    const syrArrLocal  = flight ? utcTimeStr(flight.arrivalDateTime) : null
    const syrDepUtc    = flight ? localToUtc(flight.departureDateTime, dep) : null
    const syrArrUtc    = flight ? localToUtc(flight.arrivalDateTime, arr) : null
    const syrFlightNum = flight?.flightNumber ?? null
    const syrDays      = days.map(d => JS_TO_RM_DAY[SYR_TO_JS_DAY[d]])

    const routeKey = `${dep}|${arr}`
    const rmMatches = rmByRoute.get(routeKey) ?? []

    if (rmMatches.length === 0) {
      results.push({
        status: 'MISSING_IN_RM',
        dep, arr,
        syr_flight: syrFlightNum,
        syr_dep_local: syrDepLocal, syr_arr_local: syrArrLocal,
        syr_dep_utc: syrDepUtc,    syr_arr_utc: syrArrUtc,
        syr_days: syrDays,
        rm: null,
      })
      continue
    }

    for (const rm of rmMatches) {
      const rmDepUtc = rm.dep_time_utc ? rm.dep_time_utc.slice(0,5) : null
      const rmArrUtc = rm.arr_time_utc ? rm.arr_time_utc.slice(0,5) : null

      const depMismatch = syrDepUtc && rmDepUtc && syrDepUtc !== rmDepUtc
      const arrMismatch = syrArrUtc && rmArrUtc && syrArrUtc !== rmArrUtc
      const status = (depMismatch || arrMismatch) ? 'TIME_MISMATCH' : 'OK'

      results.push({
        status,
        dep, arr,
        rm_id: rm.id,
        iata_number: rm.iata_number,
        syr_flight: syrFlightNum,
        syr_dep_local: syrDepLocal,  syr_arr_local: syrArrLocal,
        syr_dep_utc: syrDepUtc,      syr_arr_utc: syrArrUtc,
        syr_days: syrDays,
        rm_dep_utc: rmDepUtc,        rm_arr_utc: rmArrUtc,
        rm_days: rm.days_of_week,
        dep_match: !depMismatch,
        arr_match: !arrMismatch,
      })
    }
  }

  const mismatches = results.filter((r: any) => r.status !== 'OK')

  return NextResponse.json({
    ok: true,
    total: results.length,
    mismatches: mismatches.length,
    results,
  })
}

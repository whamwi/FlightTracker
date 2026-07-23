import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

// Local UTC offsets for airports we operate (summer/DST, Jul–Oct)
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
const SYR_TO_JS_DAY: Record<number, number> = { 1:0, 2:1, 3:2, 4:3, 5:4, 6:5, 7:6 }
const JS_TO_RM_DAY = ['sun','mon','tue','wed','thu','fri','sat']

interface SyrRouteIn {
  departureAirport: string
  arrivalAirport:   string
  departureToArrivalDays: number[]
  // times from available-flights (local time, no TZ suffix)
  depLocalTime?: string   // e.g. "13:00"
  arrLocalTime?: string   // e.g. "15:40"
  flightNumber?: string
  duration?: string
}

interface RmRow {
  id: number
  flight_id: number
  dep_iata: string
  arr_iata: string
  dep_time_utc: string | null
  arr_time_utc: string | null
  days_of_week: string[]
  source: string
  iata_number: string | null
}

function localToUtc(hhmm: string, airportCode: string): string | null {
  const offset = TZ_OFFSET[airportCode]
  if (offset === undefined || !hhmm) return null
  const [h, m] = hhmm.split(':').map(Number)
  const utcH = ((h - offset) % 24 + 24) % 24
  return `${String(utcH).padStart(2,'0')}:${String(m).padStart(2,'0')}`
}

async function fetchRouteMaster(): Promise<RmRow[]> {
  const [rmRes, flRes] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/route_master?select=id,flight_id,dep_iata,arr_iata,dep_time_utc,arr_time_utc,days_of_week,source`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    }),
    fetch(`${SB_URL}/rest/v1/flight_lookup?select=id,iata_number`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    }),
  ])
  if (!rmRes.ok) throw new Error(`route_master: ${rmRes.status}`)
  if (!flRes.ok) throw new Error(`flight_lookup: ${flRes.status}`)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rmRows: any[] = await rmRes.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flRows: any[] = await flRes.json()
  const flMap = new Map(flRows.map((f: { id: number; iata_number: string }) => [f.id, f.iata_number]))

  return rmRows.map(r => ({ ...r, iata_number: flMap.get(r.flight_id) ?? null }))
}

// POST: accept syrlines route data (fetched locally) and return comparison
export async function POST(req: Request) {
  try {
    const routes: SyrRouteIn[] = await req.json()
    const rmRows = await fetchRouteMaster()

    const rmByRoute = new Map<string, RmRow[]>()
    for (const r of rmRows) {
      const key = `${r.dep_iata}|${r.arr_iata}`
      if (!rmByRoute.has(key)) rmByRoute.set(key, [])
      rmByRoute.get(key)!.push(r)
    }

    const results: object[] = []

    for (const route of routes) {
      const { departureAirport: dep, arrivalAirport: arr, departureToArrivalDays: days } = route
      const syrDays = days.map(d => JS_TO_RM_DAY[SYR_TO_JS_DAY[d]])
      const syrDepUtc = route.depLocalTime ? localToUtc(route.depLocalTime, dep) : null
      const syrArrUtc = route.arrLocalTime ? localToUtc(route.arrLocalTime, arr) : null

      const routeKey = `${dep}|${arr}`
      const rmMatches = rmByRoute.get(routeKey) ?? []

      if (rmMatches.length === 0) {
        results.push({
          status: 'MISSING_IN_RM', dep, arr,
          syr_flight: route.flightNumber ?? null,
          syr_dep_local: route.depLocalTime, syr_arr_local: route.arrLocalTime,
          syr_dep_utc: syrDepUtc, syr_arr_utc: syrArrUtc,
          syr_days: syrDays, rm: null,
        })
        continue
      }

      for (const rm of rmMatches) {
        const rmDepUtc = rm.dep_time_utc ? rm.dep_time_utc.slice(0, 5) : null
        const rmArrUtc = rm.arr_time_utc ? rm.arr_time_utc.slice(0, 5) : null
        const depMismatch = syrDepUtc && rmDepUtc && syrDepUtc !== rmDepUtc
        const arrMismatch = syrArrUtc && rmArrUtc && syrArrUtc !== rmArrUtc
        const status = (depMismatch || arrMismatch) ? 'TIME_MISMATCH' : 'OK'
        results.push({
          status, dep, arr,
          rm_id: rm.id, iata_number: rm.iata_number,
          syr_flight: route.flightNumber ?? null,
          syr_dep_local: route.depLocalTime, syr_arr_local: route.arrLocalTime,
          syr_dep_utc: syrDepUtc, syr_arr_utc: syrArrUtc,
          syr_days: syrDays,
          rm_dep_utc: rmDepUtc, rm_arr_utc: rmArrUtc,
          rm_days: rm.days_of_week,
          dep_match: !depMismatch, arr_match: !arrMismatch,
        })
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mismatches = results.filter((r: any) => r.status !== 'OK')
    return NextResponse.json({ ok: true, total: results.length, mismatches: mismatches.length, results })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

// GET: returns instructions (the actual data fetch must come from local script)
export async function GET() {
  return NextResponse.json({
    ok: true,
    info: 'POST syrlines route data here. Use /private/tmp/push_syrianair.py to fetch and push.',
    endpoint: 'POST /api/sync/syrian-airlines',
    payload: '[ { departureAirport, arrivalAirport, departureToArrivalDays, depLocalTime, arrLocalTime, flightNumber, duration } ]',
  })
}

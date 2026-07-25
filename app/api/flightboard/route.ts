import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const PREFIX_TO_IATA: Record<string, string> = {
  FYC: 'XH',
  SYR: 'RB',
  HST: 'RB',
}

function unixToUtcHHMM(unix: number | null): string {
  if (!unix) return ''
  const d = new Date(unix * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// Extract HH:MM from FR24 status text and convert Syria local (UTC+3) → UTC ISO
function extractStatusUtc(raw: string | null, operatingDate: string): string | null {
  if (!raw) return null
  const match = raw.match(/\b(\d{1,2}):(\d{2})\b/)
  if (!match) return null
  const baseMs = new Date(operatingDate + 'T00:00:00Z').getTime()
  return new Date(baseMs + (parseInt(match[1]) * 60 + parseInt(match[2]) - 180) * 60_000).toISOString()
}

function normaliseStatus(raw: string | null): string {
  if (!raw) return 'Scheduled'
  const t = raw.toLowerCase()
  if (t === 'scheduled' || t === 'scheduled*')                return 'Scheduled'
  if (t.startsWith('delayed'))                                return 'Delayed'
  if (t.startsWith('estimated') || t.startsWith('expect'))    return 'Expected'
  if (t.includes('boarding'))                                  return 'Boarding'
  if (t.includes('gate close'))                               return 'GateClosed'
  if (t.includes('departed') || t.includes('took off'))       return 'Departed'
  if (t.includes('en route') || t.includes('in flight'))      return 'En Route'
  if (t.includes('approach'))                                  return 'Approaching'
  if (t.includes('landed') || t.includes('arrived'))          return 'Arrived'
  if (t.includes('cancel'))                                    return 'Cancelled'
  return 'Scheduled'
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  if (!date) return NextResponse.json({ ok: false, error: 'date required' }, { status: 400 })

  const [cacheRes, airlinesRes] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${date}&select=airport_iata,arrivals,departures`, { headers: HEADERS }),
    fetch(`${SB_URL}/rest/v1/airlines?select=iata,name_en,country_flag`, { headers: HEADERS }),
  ])

  if (!cacheRes.ok) {
    return NextResponse.json({ ok: false, error: `cache fetch failed: ${cacheRes.status}` }, { status: 502 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cacheRows: any[]   = await cacheRes.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const airlineRows: any[] = airlinesRes.ok ? await airlinesRes.json() : []

  const airlineMap: Record<string, { name: string; flag: string }> = {}
  for (const a of airlineRows) {
    airlineMap[a.iata] = { name: a.name_en ?? a.iata, flag: a.country_flag ?? '' }
  }

  // Damascus-day bounds — flights arriving at Syrian airports must land within this window.
  // Origin-airport caches are bucketed by DEPARTURE date, so an overnight flight departing
  // MJI July 25 → arriving DAM July 26 would otherwise bleed onto the July 25 board.
  const dayStartMs = new Date(date + 'T00:00:00+03:00').getTime()
  const dayEndMs   = dayStartMs + 24 * 60 * 60 * 1000
  const SYRIAN_AIRPORTS = new Set(['DAM', 'ALP', 'LTK'])

  // Status priority: higher rank wins when the same flight appears in multiple airport caches.
  // Landed/Arrived (8) beats Departed (5) beats Scheduled (1) — so origin airports supply
  // the "Departed" signal for in-flight arrivals, while destination airports supply "Arrived"
  // once the plane actually lands (overriding the origin's stale "Departed").
  const STATUS_RANK: Record<string, number> = {
    Arrived: 8, Landed: 8, Approaching: 7, 'En Route': 6,
    Departed: 5, Delayed: 4, GateClosed: 3, Boarding: 3,
    Expected: 2, Scheduled: 1, Cancelled: 0, Unknown: 0,
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flightMap: Record<string, any> = {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function addFlight(f: any) {
    const num      = f.num       ?? ''
    const depIata  = f.dep_iata  ?? ''
    const arrIata  = f.arr_iata  ?? ''
    const schedDep = f.sched_dep ?? null
    const schedArr = f.sched_arr ?? null

    // Drop overnight arrivals that land on a different Damascus calendar day
    if (arrIata && SYRIAN_AIRPORTS.has(arrIata) && schedArr) {
      const arrMs = schedArr * 1000
      if (arrMs < dayStartMs || arrMs >= dayEndMs) return
    }

    const key    = `${num}|${depIata}|${arrIata}|${schedDep ?? ''}`
    const status = normaliseStatus(f.status)

    if (flightMap[key]) {
      // Keep the best status; merge actual/revised times if not already set
      const existRank = STATUS_RANK[flightMap[key].status] ?? 0
      if ((STATUS_RANK[status] ?? 0) > existRank) flightMap[key].status = status
      if (f.fr24_actual_dep  && !flightMap[key].actual_dep_utc)  flightMap[key].actual_dep_utc  = f.fr24_actual_dep
      if (f.fr24_actual_arr  && !flightMap[key].actual_arr_utc)  flightMap[key].actual_arr_utc  = f.fr24_actual_arr
      if (f.fr24_revised_dep && !flightMap[key].revised_dep_utc) flightMap[key].revised_dep_utc = f.fr24_revised_dep
      if (f.fr24_revised_arr && !flightMap[key].revised_arr_utc) flightMap[key].revised_arr_utc = f.fr24_revised_arr
      return
    }

    const airlineIata  = f.airline_iata || PREFIX_TO_IATA[num.slice(0, 3)] || ''
    const al           = airlineMap[airlineIata] ?? { name: f.airline ?? airlineIata, flag: '' }

    flightMap[key] = {
      iata_number:     num,
      airline_name:    al.name,
      airline_iata:    airlineIata,
      country_flag:    al.flag,
      dep_iata:        depIata,
      arr_iata:        arrIata,
      dep_time_utc:    unixToUtcHHMM(schedDep),
      arr_time_utc:    unixToUtcHHMM(schedArr),
      duration_min:    f.duration_min ?? 0,
      sched_dep_unix:  schedDep,
      status,
      actual_dep_utc:  f.fr24_actual_dep  ?? null,
      actual_arr_utc:  f.fr24_actual_arr  ?? null,
      revised_dep_utc: f.fr24_revised_dep ?? null,
      revised_arr_utc: f.fr24_revised_arr ?? null,
      aircraft_type:   f.aircraft ?? null,
      aircraft_reg:    f.reg      ?? null,
    }
  }

  for (const row of cacheRows) {
    const ap = row.airport_iata as string
    for (const f of (row.departures ?? [])) {
      const t = (f.status ?? '').toLowerCase()
      addFlight({
        ...f,
        dep_iata:         f.dep_iata || ap,
        fr24_actual_dep:  t.includes('departed') || t.includes('took off') ? extractStatusUtc(f.status, date) : null,
        fr24_revised_dep: t.startsWith('estimated') || t.startsWith('expect') || t.startsWith('delayed') ? extractStatusUtc(f.status, date) : null,
      })
    }
    for (const f of (row.arrivals ?? [])) {
      const t = (f.status ?? '').toLowerCase()
      addFlight({
        ...f,
        arr_iata:         f.arr_iata || ap,
        fr24_actual_arr:  t.includes('landed') || t.includes('arrived') ? extractStatusUtc(f.status, date) : null,
        fr24_revised_arr: t.startsWith('estimated') || t.startsWith('expect') || t.startsWith('delayed') ? extractStatusUtc(f.status, date) : null,
      })
    }
  }

  return NextResponse.json({ ok: true, date, flights: Object.values(flightMap) })
}

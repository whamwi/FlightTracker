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

// Hardcoded airline data — eliminates a Supabase round trip on every board load.
// Update here when a new carrier starts serving Syrian airports.
const AIRLINE_MAP: Record<string, { name: string; flag: string }> = {
  '3L': { name: 'Air Arabia Abu Dhabi', flag: '🇦🇪' },
  DN:   { name: 'Dan Air',              flag: '🇱🇹' },
  EK:   { name: 'Emirates',             flag: '🇦🇪' },
  EY:   { name: 'Etihad Airways',       flag: '🇦🇪' },
  F3:   { name: 'Flyadeal',             flag: '🇸🇦' },
  FZ:   { name: 'Flydubai',             flag: '🇦🇪' },
  G9:   { name: 'Air Arabia',           flag: '🇦🇪' },
  J9:   { name: 'Jazeera Airways',      flag: '🇰🇼' },
  KU:   { name: 'Kuwait Airways',       flag: '🇰🇼' },
  PC:   { name: 'Pegasus Airlines',     flag: '🇹🇷' },
  QR:   { name: 'Qatar Airways',        flag: '🇶🇦' },
  RB:   { name: 'Syrian Arab Airlines', flag: '🇸🇾' },
  RJ:   { name: 'Royal Jordanian',      flag: '🇯🇴' },
  TK:   { name: 'Turkish Airlines',     flag: '🇹🇷' },
  VF:   { name: 'Anadolujet',           flag: '🇹🇷' },
  XH:   { name: 'Fly Cham',             flag: '🇸🇾' },
  XY:   { name: 'Flynas',               flag: '🇸🇦' },
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

  // Only fetch Syrian airport rows — origin-airport caches (IST, DXB…) are excluded;
  // they bloated the response to 2950 flights and added no unique data for the board.
  const syriaCodes = ['DAM', 'ALP', 'LTK'].join(',')
  const cacheRes = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${date}&airport_iata=in.(${syriaCodes})&select=airport_iata,arrivals,departures`,
    { headers: HEADERS }
  )

  if (!cacheRes.ok) {
    return NextResponse.json({ ok: false, error: `cache fetch failed: ${cacheRes.status}` }, { status: 502 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cacheRows: any[] = await cacheRes.json()

  // Damascus-day bounds — flights arriving at Syrian airports must land within this window.
  const dayStartMs = new Date(date + 'T00:00:00+03:00').getTime()
  const dayEndMs   = dayStartMs + 24 * 60 * 60 * 1000
  const SYRIAN_AIRPORTS = new Set(['DAM', 'ALP', 'LTK'])

  // Status priority: higher rank wins when the same flight appears in multiple airport caches.
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

    // Only keep flights that touch a Syrian airport
    if (!SYRIAN_AIRPORTS.has(depIata) && !SYRIAN_AIRPORTS.has(arrIata)) return

    // Drop overnight arrivals that land on a different Damascus calendar day
    if (arrIata && SYRIAN_AIRPORTS.has(arrIata) && schedArr) {
      const arrMs = schedArr * 1000
      if (arrMs < dayStartMs || arrMs >= dayEndMs) return
    }

    // If FR24's estimated arrival has slipped past Syria midnight, exclude from today's board.
    // The prev-day overflow pass will add it to tomorrow's board instead.
    if (arrIata && SYRIAN_AIRPORTS.has(arrIata) && f.est_arr && schedArr) {
      if (f.est_arr > schedArr && f.est_arr * 1000 >= dayEndMs) return
    }

    const key    = `${num}|${depIata}|${arrIata}`
    const status = normaliseStatus(f.status)

    if (flightMap[key]) {
      const existRank = STATUS_RANK[flightMap[key].status] ?? 0
      const newRank   = STATUS_RANK[status] ?? 0
      // Always take the best status seen across all entries
      if (newRank > existRank) flightMap[key].status = status
      // Always overwrite timing with the latest entry (later in array = more recent FR24 data)
      if (schedDep) flightMap[key].dep_time_utc = unixToUtcHHMM(schedDep)
      if (schedArr) flightMap[key].arr_time_utc = unixToUtcHHMM(schedArr)
      if (f.duration_min) flightMap[key].duration_min = f.duration_min
      if (f.fr24_actual_dep)  flightMap[key].actual_dep_utc  = f.fr24_actual_dep
      if (f.fr24_actual_arr)  flightMap[key].actual_arr_utc  = f.fr24_actual_arr
      if (f.fr24_revised_dep) flightMap[key].revised_dep_utc = f.fr24_revised_dep
      if (f.fr24_revised_arr) flightMap[key].revised_arr_utc = f.fr24_revised_arr
      return
    }

    const airlineIata = f.airline_iata || PREFIX_TO_IATA[num.slice(0, 3)] || ''
    const al          = AIRLINE_MAP[airlineIata] ?? { name: f.airline ?? airlineIata, flag: '' }

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
      status,
      actual_dep_utc:  f.fr24_actual_dep  ?? null,
      actual_arr_utc:  f.fr24_actual_arr  ?? null,
      revised_dep_utc: f.fr24_revised_dep ?? null,
      revised_arr_utc: f.fr24_revised_arr ?? null,
      aircraft_type:   f.aircraft ?? null,
      aircraft_reg:    f.reg      ?? null,
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function processDeparture(f: any, ap: string, d: string) {
    const t = (f.status ?? '').toLowerCase()
    addFlight({
      ...f,
      dep_iata:         f.dep_iata || ap,
      fr24_actual_dep:  t.includes('departed') || t.includes('took off')
        ? extractStatusUtc(f.status, d)
        : (f.real_dep ? new Date(f.real_dep * 1000).toISOString() : null),
      fr24_revised_dep: t.startsWith('estimated') || t.startsWith('expect') || t.startsWith('delayed')
        ? extractStatusUtc(f.status, d)
        : (f.est_dep ? new Date(f.est_dep * 1000).toISOString() : null),
    })
  }

  // Collect non-Syrian origin airports from Syrian arrival rows so we can query
  // their departure caches in a second pass — gives us "Departed" / "En Route"
  // status for flights still in the air when the destination cache says "Scheduled".
  const originSet = new Set<string>()

  for (const row of cacheRows) {
    const ap = row.airport_iata as string
    for (const f of (row.departures ?? [])) processDeparture(f, ap, date)
    for (const f of (row.arrivals ?? [])) {
      const t = (f.status ?? '').toLowerCase()
      addFlight({
        ...f,
        arr_iata:         f.arr_iata || ap,
        fr24_actual_arr:  t.includes('landed') || t.includes('arrived')
          ? extractStatusUtc(f.status, date)
          : (f.real_arr ? new Date(f.real_arr * 1000).toISOString() : null),
        fr24_revised_arr: t.startsWith('estimated') || t.startsWith('expect') || t.startsWith('delayed')
          ? extractStatusUtc(f.status, date)
          : (f.est_arr ? new Date(f.est_arr * 1000).toISOString() : null),
      })
      // Collect origin for second pass
      const dep = (f.dep_iata || '') as string
      if (dep && !SYRIAN_AIRPORTS.has(dep)) originSet.add(dep)
    }
  }

  // Second pass: read departure caches from origin airports.
  // Only departures are needed (we want their outbound status toward Syria).
  if (originSet.size > 0) {
    const originCodes = [...originSet].join(',')
    const originRes = await fetch(
      `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${date}&airport_iata=in.(${originCodes})&select=airport_iata,departures`,
      { headers: HEADERS }
    )
    if (originRes.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const originRows: any[] = await originRes.json()
      for (const row of originRows) {
        const ap = row.airport_iata as string
        for (const f of (row.departures ?? [])) processDeparture(f, ap, date)
      }
    }
  }

  // Third pass: previous Syria day's arrivals whose est_arr falls within today's window.
  // Catches flights delayed past Syria midnight that should appear on today's board.
  {
    const prev = new Date(date + 'T12:00:00Z')
    prev.setUTCDate(prev.getUTCDate() - 1)
    const prevDate = prev.toISOString().slice(0, 10)
    const prevRes = await fetch(
      `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${prevDate}&airport_iata=in.(${syriaCodes})&select=airport_iata,arrivals`,
      { headers: HEADERS }
    )
    if (prevRes.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prevRows: any[] = await prevRes.json()
      for (const row of prevRows) {
        const ap = row.airport_iata as string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const f of (row.arrivals ?? [])) {
          if (!f.est_arr || !f.sched_arr || f.est_arr <= f.sched_arr) continue
          const estMs = (f.est_arr as number) * 1000
          if (estMs < dayStartMs || estMs >= dayEndMs) continue
          const arrIata = f.arr_iata || ap
          const key = `${f.num ?? ''}|${f.dep_iata ?? ''}|${arrIata}`
          // First-entry-wins: don't override today's scheduled service if same key exists
          if (flightMap[key]) continue
          addFlight({
            ...f,
            sched_arr: f.est_arr,  // shift day-assignment to the estimated landing time
            arr_iata: arrIata,
            fr24_revised_arr: new Date(f.est_arr * 1000).toISOString(),
            fr24_actual_arr:  f.real_arr ? new Date(f.real_arr * 1000).toISOString() : null,
          })
        }
      }
    }
  }

  return NextResponse.json(
    { ok: true, date, flights: Object.values(flightMap) },
    { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } }
  )
}

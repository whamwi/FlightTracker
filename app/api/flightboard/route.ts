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

  const seen    = new Set<string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flights: any[] = []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function addFlight(f: any) {
    const num      = f.num       ?? ''
    const depIata  = f.dep_iata  ?? ''
    const arrIata  = f.arr_iata  ?? ''
    const schedDep = f.sched_dep ?? null
    const schedArr = f.sched_arr ?? null

    const key = `${num}|${depIata}|${arrIata}|${schedDep ?? ''}`
    if (seen.has(key)) return
    seen.add(key)

    const airlineIata  = f.airline_iata || PREFIX_TO_IATA[num.slice(0, 3)] || ''
    const al           = airlineMap[airlineIata] ?? { name: f.airline ?? airlineIata, flag: '' }
    const dep_time_utc = unixToUtcHHMM(schedDep)
    const arr_time_utc = unixToUtcHHMM(schedArr)

    flights.push({
      iata_number:    num,
      airline_name:   al.name,
      airline_iata:   airlineIata,
      country_flag:   al.flag,
      dep_iata:       depIata,
      arr_iata:       arrIata,
      dep_time_utc,
      arr_time_utc,
      duration_min:   f.duration_min ?? 0,
      status:         normaliseStatus(f.status),
      actual_dep_utc: f.fr24_actual_dep  ?? null,
      actual_arr_utc: f.fr24_actual_arr  ?? null,
      revised_dep_utc: f.fr24_revised_dep ?? null,
      revised_arr_utc: f.fr24_revised_arr ?? null,
      aircraft_type:  f.aircraft ?? null,
      aircraft_reg:   f.reg      ?? null,
    })
  }

  // Pass 1 — departures: origin airports know "Departed" as soon as the plane leaves.
  // Processing departures first means the "Departed" status wins the dedup over the
  // destination airport's stale "Scheduled" arrival entry for the same flight.
  for (const row of cacheRows) {
    const ap = row.airport_iata as string
    for (const f of (row.departures ?? [])) {
      const t = (f.status ?? '').toLowerCase()
      addFlight({
        ...f,
        dep_iata:         f.dep_iata || ap,
        fr24_actual_dep:  t.includes('departed') || t.includes('took off') ? extractStatusUtc(f.status, date) : null,
        fr24_revised_dep: t.startsWith('estimated') || t.startsWith('expect') ? extractStatusUtc(f.status, date) : null,
      })
    }
  }
  // Pass 2 — arrivals: destination airports know "Landed" once the plane touches down.
  // Flights already seen in pass 1 are deduplicated — their departure status is preserved.
  for (const row of cacheRows) {
    const ap = row.airport_iata as string
    for (const f of (row.arrivals ?? [])) {
      const t = (f.status ?? '').toLowerCase()
      addFlight({
        ...f,
        arr_iata:         f.arr_iata || ap,
        fr24_actual_arr:  t.includes('landed') || t.includes('arrived') ? extractStatusUtc(f.status, date) : null,
        fr24_revised_arr: t.startsWith('estimated') || t.startsWith('expect') ? extractStatusUtc(f.status, date) : null,
      })
    }
  }

  return NextResponse.json({ ok: true, date, flights })
}

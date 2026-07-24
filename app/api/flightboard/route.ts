import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

function unixToUtcHHMM(unix: number | null): string {
  if (!unix) return ''
  const d = new Date(unix * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// Normalise the raw FR24 status text to a board status key
function normaliseStatus(raw: string | null): string {
  if (!raw) return 'Scheduled'
  const t = raw.toLowerCase()
  if (t === 'scheduled')                                    return 'Scheduled'
  if (t.startsWith('estimated') || t.startsWith('expect')) return 'Expected'
  if (t.includes('boarding'))                               return 'Boarding'
  if (t.includes('gate close'))                             return 'GateClosed'
  if (t.includes('departed') || t.includes('took off'))     return 'Departed'
  if (t.includes('en route') || t.includes('in flight'))   return 'En Route'
  if (t.includes('approach'))                               return 'Approaching'
  if (t.includes('landed') || t.includes('arrived'))       return 'Arrived'
  if (t.includes('cancel'))                                 return 'Cancelled'
  return 'Scheduled'
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  if (!date) return NextResponse.json({ ok: false, error: 'date required' }, { status: 400 })

  // Fetch all three in parallel
  const [cacheRes, airlinesRes, statusRes] = await Promise.all([
    fetch(
      `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${date}&select=airport_iata,arrivals,departures`,
      { headers: HEADERS }
    ),
    fetch(
      `${SB_URL}/rest/v1/airlines?select=iata,name_en,country_flag`,
      { headers: HEADERS }
    ),
    fetch(
      `${SB_URL}/rest/v1/flight_status` +
      `?operating_date=eq.${date}` +
      `&select=flight_number,callsign,status,actual_dep_utc,actual_arr_utc` +
      `,revised_dep_utc,revised_arr_utc,dep_delay_min,arr_delay_min` +
      `,dep_terminal,dep_gate,dep_check_in_desk,arr_terminal,arr_gate,arr_baggage_belt` +
      `,aircraft_type,aircraft_reg`,
      { headers: HEADERS }
    ),
  ])

  if (!cacheRes.ok) {
    return NextResponse.json({ ok: false, error: `cache fetch failed: ${cacheRes.status}` }, { status: 502 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cacheRows: any[]    = await cacheRes.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const airlineRows: any[]  = airlinesRes.ok ? await airlinesRes.json() : []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statusRows: any[]   = statusRes.ok  ? await statusRes.json()  : []

  // ── Lookups ──────────────────────────────────────────────────────────────────
  const airlineMap: Record<string, { name: string; flag: string }> = {}
  for (const a of airlineRows) {
    airlineMap[a.iata] = { name: a.name_en ?? a.iata, flag: a.country_flag ?? '' }
  }

  // Index flight_status by flight_number (last write wins on duplicates)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statusMap: Record<string, any> = {}
  for (const s of statusRows) {
    const key = s.flight_number ?? s.callsign
    if (key) statusMap[key] = s
  }

  // ── Flatten JSONB arrays from all airports ────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seen  = new Set<string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flights: any[] = []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function addFlight(f: any) {
    const num      = f.num       ?? ''
    const depIata  = f.dep_iata  ?? ''
    const arrIata  = f.arr_iata  ?? ''
    const schedDep = f.sched_dep ?? null
    const schedArr = f.sched_arr ?? null

    // Dedup: same flight number + route → one row (arrivals + departures share flights)
    const key = `${num}|${depIata}|${arrIata}`
    if (seen.has(key)) return
    seen.add(key)

    const al  = airlineMap[f.airline_iata ?? ''] ?? { name: f.airline ?? f.airline_iata ?? '', flag: '' }
    const st  = statusMap[num] ?? null

    const dep_time_utc = unixToUtcHHMM(schedDep)
    const arr_time_utc = unixToUtcHHMM(schedArr)

    flights.push({
      callsign:          num,                            // widget doesn't give callsign; flight num is close enough
      iata_number:       num,
      airline_name:      al.name,
      airline_iata:      f.airline_iata ?? '',
      country_flag:      al.flag,
      dep_iata:          depIata,
      arr_iata:          arrIata,
      dep_time:          dep_time_utc,                   // used only as React key fallback
      arr_time:          arr_time_utc,
      dep_time_utc,
      arr_time_utc,
      duration_min:      f.duration_min ?? 0,
      codeshare_iata:    null,
      // Status: flight_status overlay wins, then FR24 widget status
      status:            st?.status             ?? normaliseStatus(f.status),
      actual_dep_utc:    st?.actual_dep_utc     ?? null,
      actual_arr_utc:    st?.actual_arr_utc     ?? null,
      revised_dep_utc:   st?.revised_dep_utc    ?? null,
      revised_arr_utc:   st?.revised_arr_utc    ?? null,
      dep_delay_min:     st?.dep_delay_min      ?? null,
      arr_delay_min:     st?.arr_delay_min      ?? null,
      dep_terminal:      st?.dep_terminal       ?? null,
      dep_gate:          st?.dep_gate           ?? null,
      dep_check_in_desk: st?.dep_check_in_desk  ?? null,
      arr_terminal:      st?.arr_terminal       ?? null,
      arr_gate:          st?.arr_gate           ?? null,
      arr_baggage_belt:  st?.arr_baggage_belt   ?? null,
      aircraft_type:     st?.aircraft_type      ?? f.aircraft ?? null,
      aircraft_reg:      st?.aircraft_reg       ?? f.reg      ?? null,
    })
  }

  for (const row of cacheRows) {
    for (const f of (row.departures ?? [])) addFlight(f)
    for (const f of (row.arrivals   ?? [])) addFlight(f)
  }

  return NextResponse.json({ ok: true, date, flights })
}

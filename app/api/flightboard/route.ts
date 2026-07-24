import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

// Callsign prefix → airline IATA for carriers FR24 widget doesn't carry an IATA for
const PREFIX_TO_IATA: Record<string, string> = {
  FYC: 'XH',  // Fly Cham
  SYR: 'RB',  // Syrian Air
  HST: 'RB',  // Syrian Air (operating_as code)
}

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

  // Index flight_status by flight_number — strip spaces so "FYC 741" matches "FYC741"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statusMap: Record<string, any> = {}
  for (const s of statusRows) {
    const key = (s.flight_number ?? s.callsign ?? '').replace(/\s+/g, '')
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

    // Dedup: same flight number + route + dep time → one row.
    // Include dep time so same-numbered flights at different hours (e.g. FYC501 at 09:00 and 18:30) both appear.
    const key = `${num}|${depIata}|${arrIata}|${schedDep ?? ''}`
    if (seen.has(key)) return
    seen.add(key)

    // Derive airline IATA from callsign prefix when FR24 widget omits it
    const airlineIata = f.airline_iata || PREFIX_TO_IATA[num.slice(0, 3)] || ''
    const al  = airlineMap[airlineIata] ?? { name: f.airline ?? airlineIata, flag: '' }
    const st  = statusMap[num] ?? null

    const dep_time_utc = unixToUtcHHMM(schedDep)
    const arr_time_utc = unixToUtcHHMM(schedArr)

    flights.push({
      callsign:          num,                            // widget doesn't give callsign; flight num is close enough
      iata_number:       num,
      airline_name:      al.name,
      airline_iata:      airlineIata,
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
    const ap = row.airport_iata as string
    // For departures from this airport: dep_iata = this airport (widget omits it)
    for (const f of (row.departures ?? [])) addFlight({ ...f, dep_iata: f.dep_iata || ap })
    // For arrivals at this airport: arr_iata = this airport (widget omits it)
    for (const f of (row.arrivals   ?? [])) addFlight({ ...f, arr_iata: f.arr_iata || ap })
  }

  return NextResponse.json({ ok: true, date, flights })
}

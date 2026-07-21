import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  if (!date) return NextResponse.json({ ok: false, error: 'date required' }, { status: 400 })

  // Day of week for this date (use noon UTC to avoid DST edge cases)
  const dow = DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()]

  const [schedRes, statusRes] = await Promise.all([
    fetch(
      `${SB_URL}/rest/v1/flight_schedule` +
      `?days_of_week=cs.{${dow}}` +
      `&select=dep_iata,arr_iata,dep_time,arr_time,dep_time_utc,arr_time_utc,duration_min,days_of_week,codeshare_iata` +
      `,flight_lookup(iata_number,broadcast_callsign,airlines(name_en,iata,country_flag))` +
      `&order=dep_time.asc`,
      { headers: HEADERS }
    ),
    fetch(
      `${SB_URL}/rest/v1/flight_status` +
      `?operating_date=eq.${date}` +
      `&select=callsign,status,actual_dep_utc,actual_arr_utc,revised_dep_utc,revised_arr_utc` +
      `,dep_delay_min,arr_delay_min,dep_terminal,dep_gate,dep_check_in_desk` +
      `,arr_terminal,arr_gate,arr_baggage_belt,aircraft_type,aircraft_reg`,
      { headers: HEADERS }
    ),
  ])

  if (!schedRes.ok) {
    return NextResponse.json({ ok: false, error: `schedule fetch failed: ${schedRes.status}` }, { status: 502 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schedRows: any[] = await schedRes.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statusRows: any[] = statusRes.ok ? await statusRes.json() : []

  // Index status by callsign — last row wins if duplicates exist
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byCallsign: Record<string, any> = {}
  for (const s of statusRows) byCallsign[s.callsign] = s

  const flights = schedRows
    .map(r => {
      const fl = r.flight_lookup ?? {}
      const al = fl.airlines ?? {}
      const callsign: string = fl.broadcast_callsign ?? ''
      const st = byCallsign[callsign] ?? null

      return {
        callsign,
        iata_number:       fl.iata_number    ?? '',
        airline_name:      al.name_en        ?? '',
        airline_iata:      al.iata           ?? '',
        country_flag:      al.country_flag   ?? '',
        dep_iata:          r.dep_iata        ?? '',
        arr_iata:          r.arr_iata        ?? '',
        dep_time:          r.dep_time?.slice(0, 5) ?? '',
        arr_time:          r.arr_time?.slice(0, 5) ?? '',
        dep_time_utc:      r.dep_time_utc?.slice(0, 5) ?? '',
        arr_time_utc:      r.arr_time_utc?.slice(0, 5) ?? '',
        duration_min:      r.duration_min    ?? 0,
        codeshare_iata:    r.codeshare_iata  ?? null,
        // live status — defaults to 'Scheduled' when no data yet
        status:            st?.status             ?? 'Scheduled',
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
        aircraft_type:     st?.aircraft_type      ?? null,
        aircraft_reg:      st?.aircraft_reg       ?? null,
      }
    })

  return NextResponse.json({ ok: true, date, dow, flights })
}

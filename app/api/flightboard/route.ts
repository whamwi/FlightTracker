import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

// UTC offset (hours) per airport. Default = 3 (Syria/most Mid-East airports).
const AIRPORT_UTC_OFFSET: Record<string, number> = {
  // UTC+4
  DXB: 4, AUH: 4, SHJ: 4, MCT: 4, EVN: 4,
  // UTC+2
  AMS: 2, MJI: 2,
}

function utcToLocalHHMM(iso: string | null, iata: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const offsetMin = (AIRPORT_UTC_OFFSET[iata] ?? 3) * 60
  const w = ((d.getUTCHours() * 60 + d.getUTCMinutes() + offsetMin) % 1440 + 1440) % 1440
  return `${String(Math.floor(w / 60)).padStart(2, '0')}:${String(w % 60).padStart(2, '0')}`
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  if (!date) return NextResponse.json({ ok: false, error: 'date required' }, { status: 400 })

  const [instanceRes, statusRes] = await Promise.all([
    // flight_instance for this date, joined to flight_lookup → airlines and route_master
    fetch(
      `${SB_URL}/rest/v1/flight_instance` +
      `?flight_date=eq.${date}` +
      `&select=dep_iata,arr_iata,std,sta,atd,ata,etd,eta,status` +
      `,flight_lookup!flight_id(iata_number,broadcast_callsign,airlines(name_en,iata,country_flag))` +
      `,route_master!route_id(duration_min,days_of_week)` +
      `&order=std.asc`,
      { headers: HEADERS }
    ),
    // flight_status for live overlay
    fetch(
      `${SB_URL}/rest/v1/flight_status` +
      `?operating_date=eq.${date}` +
      `&select=callsign,status,actual_dep_utc,actual_arr_utc,revised_dep_utc,revised_arr_utc` +
      `,dep_delay_min,arr_delay_min,dep_terminal,dep_gate,dep_check_in_desk` +
      `,arr_terminal,arr_gate,arr_baggage_belt,aircraft_type,aircraft_reg`,
      { headers: HEADERS }
    ),
  ])

  if (!instanceRes.ok) {
    return NextResponse.json({ ok: false, error: `instance fetch failed: ${instanceRes.status}` }, { status: 502 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instanceRows: any[] = await instanceRes.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statusRows: any[] = statusRes.ok ? await statusRes.json() : []

  // Index flight_status by callsign — last row wins if duplicates
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byCallsign: Record<string, any> = {}
  for (const s of statusRows) byCallsign[s.callsign] = s

  const flights = instanceRows.map(r => {
    const fl = r.flight_lookup ?? {}
    const al = fl.airlines ?? {}
    const rm = r.route_master ?? {}
    const callsign: string = fl.broadcast_callsign ?? ''
    const st = byCallsign[callsign] ?? null

    // Scheduled times in origin/destination airport local time
    const dep_time     = utcToLocalHHMM(r.std, r.dep_iata)
    const arr_time     = utcToLocalHHMM(r.sta, r.arr_iata)
    const dep_time_utc = r.std ? new Date(r.std).toISOString().slice(11, 16) : ''
    const arr_time_utc = r.sta ? new Date(r.sta).toISOString().slice(11, 16) : ''

    return {
      callsign,
      iata_number:       fl.iata_number   ?? '',
      airline_name:      al.name_en       ?? '',
      airline_iata:      al.iata          ?? '',
      country_flag:      al.country_flag  ?? '',
      dep_iata:          r.dep_iata       ?? '',
      arr_iata:          r.arr_iata       ?? '',
      dep_time,
      arr_time,
      dep_time_utc,
      arr_time_utc,
      duration_min:      rm.duration_min  ?? 0,
      days_of_week:      rm.days_of_week  ?? [],
      // instance status (scheduled/departed/arrived) — overridden by flight_status when available
      status:            st?.status             ?? r.status ?? 'Scheduled',
      actual_dep_utc:    st?.actual_dep_utc     ?? (r.atd ?? null),
      actual_arr_utc:    st?.actual_arr_utc     ?? (r.ata ?? null),
      revised_dep_utc:   st?.revised_dep_utc    ?? (r.etd ?? null),
      revised_arr_utc:   st?.revised_arr_utc    ?? (r.eta ?? null),
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

  return NextResponse.json({ ok: true, date, flights })
}

import { NextResponse } from 'next/server'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

export const revalidate = 3600

export async function GET() {
  const select = [
    'id',
    'dep_iata', 'arr_iata',
    'dep_time', 'arr_time',
    'dep_time_utc', 'arr_time_utc',
    'duration_min',
    'days_of_week',
    'codeshare_iata',
    'flight_lookup(iata_number,broadcast_callsign,airlines(name_en,country_flag))',
  ].join(',')

  const res = await fetch(
    `${SB_URL}/rest/v1/flight_schedule?select=${encodeURIComponent(select)}&order=dep_time_utc.asc`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  )

  if (!res.ok) return NextResponse.json({ ok: false }, { status: 502 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any[] = await res.json()

  const rows = raw.map(r => ({
    id:                r.id,
    dep_iata:          r.dep_iata,
    arr_iata:          r.arr_iata,
    dep_time:          r.dep_time?.slice(0, 5) ?? '—',
    arr_time:          r.arr_time?.slice(0, 5) ?? '—',
    dep_time_utc:      r.dep_time_utc?.slice(0, 5) ?? '—',
    arr_time_utc:      r.arr_time_utc?.slice(0, 5) ?? '—',
    duration_min:      r.duration_min ?? 0,
    days_of_week:      r.days_of_week ?? [],
    codeshare_iata:    r.codeshare_iata ?? null,
    iata_number:       r.flight_lookup?.iata_number ?? '—',
    broadcast_callsign: r.flight_lookup?.broadcast_callsign ?? '—',
    airline_name:      r.flight_lookup?.airlines?.name_en ?? '—',
    country_flag:      r.flight_lookup?.airlines?.country_flag ?? '',
  }))

  return NextResponse.json({ ok: true, rows })
}

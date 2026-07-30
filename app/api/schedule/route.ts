import { NextResponse } from 'next/server'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

export const dynamic = 'force-dynamic'

export async function GET() {
  const select = [
    'id',
    'dep_iata', 'arr_iata',
    'dep_time', 'arr_time',
    'dep_time_utc', 'arr_time_utc',
    'duration_min',
    'days_of_week',
    'flight_lookup(iata_number,broadcast_callsign,airlines(iata,name_en,country_flag,website_url,facebook_url,instagram_url))',
  ].join(',')

  const res = await fetch(
    `${SB_URL}/rest/v1/route_master?select=${encodeURIComponent(select)}&active=eq.true&order=dep_time.asc`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, cache: 'no-store' },
  )

  if (!res.ok) return NextResponse.json({ ok: false }, { status: 502 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any[] = await res.json()

  const rows = raw.map((r: any) => ({
    id:                r.id,
    dep_iata:          r.dep_iata,
    arr_iata:          r.arr_iata,
    dep_time:          r.dep_time?.slice(0, 5) ?? '—',
    arr_time:          r.arr_time?.slice(0, 5) ?? '—',
    dep_time_utc:      r.dep_time_utc?.slice(0, 5) ?? '—',
    arr_time_utc:      r.arr_time_utc?.slice(0, 5) ?? '—',
    duration_min:      r.duration_min ?? 0,
    days_of_week:      r.days_of_week ?? [],
    iata_number:       r.flight_lookup?.iata_number ?? '—',
    broadcast_callsign: r.flight_lookup?.broadcast_callsign ?? '—',
    airline_iata:      r.flight_lookup?.airlines?.iata ?? '',
    airline_name:      r.flight_lookup?.airlines?.name_en ?? '—',
    country_flag:      r.flight_lookup?.airlines?.country_flag ?? '',
    website_url:       r.flight_lookup?.airlines?.website_url ?? null,
    facebook_url:      r.flight_lookup?.airlines?.facebook_url ?? null,
    instagram_url:     r.flight_lookup?.airlines?.instagram_url ?? null,
  }))

  return NextResponse.json({ ok: true, rows }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

export async function GET() {
  // Return today's + yesterday's rows so overnight flights are covered
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

  const res = await fetch(
    `${SB_URL}/rest/v1/flight_status?operating_date=gte.${yesterday}&select=callsign,status,actual_dep_utc,actual_arr_utc,scheduled_dep_utc,scheduled_arr_utc,dep_delay_min,arr_delay_min,aircraft_reg,aircraft_type,flight_number,dep_iata,arr_iata&order=operating_date.asc`,
    {
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
      },
      next: { revalidate: 0 },
    }
  )

  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `Supabase ${res.status}` }, { status: 502 })
  }

  const rows = await res.json()
  // Key by callsign — if same callsign appears twice (yesterday + today), latest wins
  const byCallsign: Record<string, unknown> = {}
  for (const r of rows) {
    byCallsign[r.callsign] = r
  }

  return NextResponse.json({ ok: true, status: byCallsign })
}

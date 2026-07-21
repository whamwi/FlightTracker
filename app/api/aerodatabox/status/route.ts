import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

export async function GET() {
  // Departures are always today or future — never look back.
  // A flight departing today may arrive the next calendar day; that is handled by
  // the schedule window (isFlightActiveNow) and today's operating_date row.
  const today = new Date().toISOString().slice(0, 10)

  const res = await fetch(
    `${SB_URL}/rest/v1/flight_status?operating_date=eq.${today}&select=callsign,operating_date,status,actual_dep_utc,actual_arr_utc,scheduled_dep_utc,scheduled_arr_utc,revised_dep_utc,revised_arr_utc,dep_delay_min,arr_delay_min,aircraft_reg,aircraft_type,flight_number,dep_iata,arr_iata`,
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
  const byCallsign: Record<string, unknown> = {}
  for (const r of rows) {
    byCallsign[r.callsign] = r
  }

  return NextResponse.json({ ok: true, status: byCallsign })
}

import { NextResponse } from 'next/server'

/**
 * Read side for the no-activity list. Behind the same Basic auth as the rest of /api/admin.
 *
 * Open rows first, then recently resolved ones — a row that resolved was a very late
 * departure and is worth seeing beside the ones that never flew, because the difference
 * between those two is the only thing this table is really measuring.
 */

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!

export async function GET() {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)
  const res = await fetch(
    `${SB_URL}/rest/v1/flight_no_activity?flight_date=gte.${since}` +
    `&select=*&order=resolved_at.asc.nullsfirst,flight_date.desc&limit=200`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, cache: 'no-store' },
  )
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `read failed: ${res.status}` }, { status: 502 })
  }
  return NextResponse.json({ ok: true, rows: await res.json() })
}

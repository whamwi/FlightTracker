import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

export async function GET() {
  const res = await fetch(
    `${SB_URL}/rest/v1/airports?select=iata,city,city_ar,name_ar,country_ar,country_flag,lat,lon,utc_offset,timezone&order=iata`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, next: { revalidate: 3600 } }
  )
  if (!res.ok) return NextResponse.json([], { status: 502 })
  const rows = await res.json()
  return NextResponse.json(rows, {
    headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' },
  })
}

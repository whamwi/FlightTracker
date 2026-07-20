import { NextResponse } from 'next/server'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

export const dynamic = 'force-dynamic'

let cache: { data: unknown; ts: number } | null = null

export async function GET() {
  if (cache && Date.now() - cache.ts < 3_600_000)
    return NextResponse.json(cache.data)

  const res = await fetch(
    `${SB_URL}/rest/v1/route_paths?select=dep_iata,arr_iata,waypoints`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  )

  if (!res.ok) return NextResponse.json({ ok: false }, { status: 502 })

  const rows: { dep_iata: string; arr_iata: string; waypoints: unknown }[] = await res.json()
  const payload = { ok: true, paths: rows }
  cache = { data: payload, ts: Date.now() }
  return NextResponse.json(payload)
}

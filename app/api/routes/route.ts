import { NextResponse } from 'next/server'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

export const dynamic = 'force-dynamic'

let cache: { data: unknown; ts: number } | null = null

export async function GET() {
  if (cache && Date.now() - cache.ts < 3_600_000)
    return NextResponse.json(cache.data)

  // A route may now hold several corridors (route_paths.variant). Callers of this endpoint
  // key paths by OD pair alone, so returning more than one row per pair would let an
  // arbitrary corridor silently overwrite the others. Collapse to the most-observed one;
  // consumers that understand variants should query them explicitly.
  const res = await fetch(
    `${SB_URL}/rest/v1/route_paths` +
    `?select=dep_iata,arr_iata,variant,waypoints,observed_count` +
    `&order=observed_count.desc,variant.asc`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  )

  if (!res.ok) return NextResponse.json({ ok: false }, { status: 502 })

  const rows: { dep_iata: string; arr_iata: string; waypoints: unknown }[] = await res.json()

  const seen = new Set<string>()
  const paths = rows.filter(r => {
    const od = `${r.dep_iata}|${r.arr_iata}`
    if (seen.has(od)) return false
    seen.add(od)
    return true
  })

  const payload = { ok: true, paths }
  cache = { data: payload, ts: Date.now() }
  return NextResponse.json(payload)
}

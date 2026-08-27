import { NextResponse } from 'next/server'
import { SYRIA_AIRPORTS } from '@/lib/syria-airports'

/**
 * Every airport the map should mark, derived from the schedule rather than written out by hand.
 *
 * This exists because the hand-written version drifted. Moscow and Yerevan were both missing from
 * the map while both were active in route_master — DAM-SVO on Sundays, ALP-EVN on Tuesdays — and
 * nobody noticed until someone looked at the map and asked where Moscow was. Cologne and Medina
 * were missing too, and nobody had asked about those yet.
 *
 * A list maintained by remembering to maintain it is a list that is wrong. route_master already
 * knows which airports are served; this reads it.
 *
 * ── The two sources, and why both ──
 *
 * ACTIVE ROUTES give the destinations, both ends of every active row.
 *
 * THE SYRIAN AIRPORTS are added regardless. Latakia has no active route today and would drop off
 * a purely schedule-derived list, but this is a map of Syrian aviation: its four airports belong
 * on it whether or not anything is scheduled this week. SYRIA_AIRPORTS is the shared list, not a
 * fifth copy — see lib/syria-airports.
 *
 * Coordinates come from the airports table, so an airport with no row there is dropped rather
 * than drawn at a guess.
 */

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!

/*
 * Cached for an hour. The schedule changes when an airline files something new, which is weeks
 * apart — the map does not need a fresh answer per visitor, and route_master is not a table to
 * hammer from a page that 72% of readers open on a phone.
 */
export const revalidate = 3600

async function sb(path: string) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    next: { revalidate },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status}`)
  return res.json()
}

export async function GET() {
  try {
    const routes: { dep_iata: string; arr_iata: string }[] =
      await sb('/route_master?active=eq.true&select=dep_iata,arr_iata')

    const wanted = new Set<string>(SYRIA_AIRPORTS)
    for (const r of routes) {
      if (r.dep_iata) wanted.add(r.dep_iata)
      if (r.arr_iata) wanted.add(r.arr_iata)
    }

    const codes = [...wanted].sort()
    const rows: { iata: string; lat: number | null; lon: number | null }[] =
      await sb(`/airports?iata=in.(${codes.join(',')})&select=iata,lat,lon`)

    // An airport with no coordinates cannot be drawn. Dropped rather than placed at 0,0 — which
    // is in the Atlantic and would look like a bug in the map rather than a gap in the data.
    const airports = rows
      .filter(r => typeof r.lat === 'number' && typeof r.lon === 'number')
      .map(r => ({ iata: r.iata, lat: r.lat as number, lon: r.lon as number }))
      .sort((a, b) => a.iata.localeCompare(b.iata))

    return NextResponse.json({ ok: true, airports })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), airports: [] },
      { status: 500 },
    )
  }
}

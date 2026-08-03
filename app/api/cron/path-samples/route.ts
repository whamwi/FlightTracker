import { NextResponse } from 'next/server'
import { indexPaths, buildSamples, type RoutePathRow } from '@/lib/path-samples'

/**
 * Records where flights actually fly, so route geometry can be corrected from evidence.
 *
 * Reads /api/airspace rather than the ADS-B feed directly. The feed gives positions but not
 * which flight they belong to — the callsign lookup, FR24 board match and OD resolution all
 * live in that endpoint, and duplicating them here would leave two copies of the hardest
 * matching logic in the codebase to drift apart. One internal request a minute is nothing
 * beside what it saves.
 *
 * Sampling server-side rather than from the map is the important part. PathTracker runs in
 * the browser, so client-side logging would write the same observation once per viewer,
 * write nothing at all when nobody is watching, and make the data depend on who happened to
 * have the page open. Here there is exactly one writer.
 *
 * This only records. Nothing reads these samples yet, and no route is modified by them —
 * aggregation and corridor proposals are a separate step, deliberately, because a week of
 * data has to exist before any of it can be tested.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const SB_URL     = process.env.SUPABASE_URL!
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const SELF = process.env.NEXT_PUBLIC_SITE_URL
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://www.flysyria.app')

export async function GET() {
  const started = Date.now()

  const [airspaceRes, pathsRes] = await Promise.all([
    fetch(`${SELF}/api/airspace`, { cache: 'no-store' }),
    fetch(`${SB_URL}/rest/v1/route_paths?select=dep_iata,arr_iata,variant,waypoints`, { headers: SB_HEADERS }),
  ])

  if (!airspaceRes.ok) {
    return NextResponse.json({ ok: false, step: 'airspace', status: airspaceRes.status }, { status: 502 })
  }
  if (!pathsRes.ok) {
    return NextResponse.json({ ok: false, step: 'route_paths', status: pathsRes.status }, { status: 502 })
  }

  const airspace = await airspaceRes.json()
  const pathRows: RoutePathRow[] = await pathsRes.json()

  const paths = indexPaths(pathRows)
  const { samples, skipped } = buildSamples(airspace.aircraft ?? [], paths, Date.now())

  let written = 0
  if (samples.length) {
    // Ignore duplicates rather than erroring: the unique index on (callsign, flight_date,
    // seen_at) means a retried or overlapping invocation re-offers rows it already wrote.
    const res = await fetch(`${SB_URL}/rest/v1/route_path_samples`, {
      method:  'POST',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body:    JSON.stringify(samples),
    })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      console.error('[path-samples] insert failed', res.status, body)
      return NextResponse.json({ ok: false, step: 'insert', status: res.status, body }, { status: 502 })
    }
    written = samples.length
  }

  // The worst offender each run is the useful line in the log: a route consistently topping
  // it is the one whose geometry is wrong.
  const worst = samples.reduce<typeof samples[number] | null>(
    (w, s) => (!w || s.off_path_km > w.off_path_km ? s : w), null)

  return NextResponse.json({
    ok: true,
    written,
    routes: paths.size,
    skipped,
    worst: worst && {
      callsign: worst.callsign,
      route: `${worst.dep_iata}-${worst.arr_iata}`,
      off_path_km: +worst.off_path_km.toFixed(1),
      s: +worst.s.toFixed(3),
    },
    ms: Date.now() - started,
  })
}

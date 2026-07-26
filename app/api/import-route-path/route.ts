import { NextResponse } from 'next/server'

export const dynamic    = 'force-dynamic'
export const maxDuration = 30

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R    = 3440.065
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildWaypoints(positions: any[], numWaypoints = 23): {
  waypoints: { lat: number; lon: number; f: number }[]
  total_dist_nm: number
  airborne_count: number
} {
  const airborne = positions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((p: any) => (p.alt ?? p.altitude ?? 0) > 500 && (p.gspeed ?? p.gs ?? 0) > 50)
    .sort((a: any, b: any) => (a.timestamp ?? 0) - (b.timestamp ?? 0))  // eslint-disable-line @typescript-eslint/no-explicit-any

  if (airborne.length < 4) {
    throw new Error(`Only ${airborne.length} airborne positions — not enough to build path`)
  }

  let cumDist = 0
  const track: { lat: number; lon: number; dist: number }[] = []

  for (let i = 0; i < airborne.length; i++) {
    const p   = airborne[i]
    const lat = p.lat ?? p.latitude
    const lon = p.lon ?? p.longitude
    if (typeof lat !== 'number' || typeof lon !== 'number') continue

    if (i === 0) {
      track.push({ lat, lon, dist: 0 })
    } else {
      const prev = track[track.length - 1]
      const d    = haversineNm(prev.lat, prev.lon, lat, lon)
      if (d > 200) continue  // skip position jumps (MLAT artifact filter)
      cumDist += d
      track.push({ lat, lon, dist: cumDist })
    }
  }

  const total_dist_nm = Math.round(cumDist * 10) / 10

  const waypoints: { lat: number; lon: number; f: number }[] = []
  for (let i = 0; i < numWaypoints; i++) {
    const targetF    = i / (numWaypoints - 1)
    const targetDist = targetF * cumDist
    let best    = track[0]
    let bestErr = Math.abs(track[0].dist - targetDist)
    for (const pt of track) {
      const err = Math.abs(pt.dist - targetDist)
      if (err < bestErr) { best = pt; bestErr = err }
    }
    waypoints.push({
      lat: Math.round(best.lat * 1e5) / 1e5,
      lon: Math.round(best.lon * 1e5) / 1e5,
      f:   Math.round(targetF * 1e4) / 1e4,
    })
  }

  return { waypoints, total_dist_nm, airborne_count: airborne.length }
}

// POST /api/import-route-path?dep_iata=DAM&arr_iata=KWI&save=true
//
// Body: FR24 SDK format — [{ "fr24_id": "...", "tracks": [...] }]
// The 200-nm jump filter in buildWaypoints strips MLAT garbage automatically.
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url)
  const dep_iata = searchParams.get('dep_iata')
  const arr_iata = searchParams.get('arr_iata')
  const save     = searchParams.get('save') !== 'false'   // default true
  const num      = parseInt(searchParams.get('waypoints') ?? '23', 10)

  if (!dep_iata || !arr_iata) {
    return NextResponse.json(
      { error: 'Required query params: dep_iata, arr_iata' },
      { status: 400 }
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Accept SDK format: [{ fr24_id, tracks: [...] }]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let positions: any[]
  let fr24_id: string

  if (Array.isArray(body) && body[0]?.tracks) {
    fr24_id   = body[0].fr24_id ?? 'unknown'
    positions = body[0].tracks
  } else if (Array.isArray(body)) {
    fr24_id   = searchParams.get('fr24_id') ?? 'manual'
    positions = body
  } else {
    return NextResponse.json(
      { error: 'Expected [{ fr24_id, tracks: [...] }] or a flat position array' },
      { status: 400 }
    )
  }

  let result: ReturnType<typeof buildWaypoints>
  try {
    result = buildWaypoints(positions, Math.min(Math.max(num, 5), 50))
  } catch (e) {
    return NextResponse.json({
      error: String(e),
      raw_count: positions.length,
      sample:    positions.slice(0, 3),
    }, { status: 422 })
  }

  const { waypoints, total_dist_nm, airborne_count } = result

  if (save) {
    const writeRes = await fetch(`${SB_URL}/rest/v1/route_paths`, {
      method:  'POST',
      headers: {
        apikey:         SB_KEY,
        Authorization:  `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer:         'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        dep_iata,
        arr_iata,
        waypoints,
        total_dist_nm,
        source_flights: [fr24_id],
        updated_at:     new Date().toISOString(),
      }),
    })

    if (!writeRes.ok) {
      const err = await writeRes.text()
      return NextResponse.json({ error: `DB write failed: ${err}` }, { status: 502 })
    }
  }

  return NextResponse.json({
    ok:              true,
    fr24_id,
    dep_iata,
    arr_iata,
    raw_positions:   positions.length,
    airborne_count,
    total_dist_nm,
    waypoints_count: waypoints.length,
    waypoints,
    saved:           save,
  })
}

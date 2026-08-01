import { NextResponse } from 'next/server'

export const dynamic    = 'force-dynamic'
export const maxDuration = 30

const FR24_KEY = process.env.FR24_API_KEY!
const SB_URL   = process.env.SUPABASE_URL!
const SB_KEY   = process.env.SUPABASE_ANON_KEY!

// Haversine great-circle distance in nautical miles
function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R    = 3440.065
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

async function fetchTrail(fr24_id: string): Promise<object[]> {
  const url = `https://fr24api.flightradar24.com/api/flight-tracks`
            + `?flight_id=${encodeURIComponent(fr24_id)}`

  const res = await fetch(url, {
    headers: {
      Authorization:    `Bearer ${FR24_KEY}`,
      Accept:           'application/json',
      'Accept-Version': 'v1',
    },
    signal: AbortSignal.timeout(20_000),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`FR24 API ${res.status}: ${body.slice(0, 300)}`)
  }

  const body = await res.json()
  // SDK format: [{ fr24_id, tracks: [...] }]
  if (Array.isArray(body) && body[0]?.tracks) return body[0].tracks
  // Flat array fallback
  if (Array.isArray(body)) return body
  return body.data ?? []
}

// Convert raw FR24 positions into evenly-sampled {lat, lon, f} waypoints
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildWaypoints(positions: any[], numWaypoints = 20): {
  waypoints: { lat: number; lon: number; f: number }[]
  total_dist_nm: number
  airborne_count: number
} {
  // Filter to airborne, sort by timestamp
  const airborne = positions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((p: any) => (p.alt ?? p.altitude ?? 0) > 500 && (p.gspeed ?? p.gs ?? 0) > 50)
    .sort((a: any, b: any) => (a.timestamp ?? 0) - (b.timestamp ?? 0))  // eslint-disable-line @typescript-eslint/no-explicit-any

  if (airborne.length < 4) {
    throw new Error(`Only ${airborne.length} airborne positions — not enough to build path`)
  }

  // Step 1: collect raw points, skipping >200nm jumps (GPS artifacts)
  const raw: { lat: number; lon: number }[] = []
  for (const p of airborne) {
    const lat = p.lat ?? p.latitude
    const lon = p.lon ?? p.longitude
    if (typeof lat !== 'number' || typeof lon !== 'number') continue
    if (raw.length === 0) {
      raw.push({ lat, lon })
    } else {
      const prev = raw[raw.length - 1]
      if (haversineNm(prev.lat, prev.lon, lat, lon) < 200) raw.push({ lat, lon })
    }
  }

  // Step 2: gap-fill — linearly interpolate at 10nm intervals between sparse points
  const FILL_INTERVAL_NM = 10
  const dense: { lat: number; lon: number }[] = [raw[0]]
  for (let i = 1; i < raw.length; i++) {
    const A = raw[i - 1], B = raw[i]
    const d = haversineNm(A.lat, A.lon, B.lat, B.lon)
    if (d > FILL_INTERVAL_NM) {
      const steps = Math.floor(d / FILL_INTERVAL_NM)
      for (let j = 1; j < steps; j++) {
        const frac = j / steps
        dense.push({ lat: A.lat + frac * (B.lat - A.lat), lon: A.lon + frac * (B.lon - A.lon) })
      }
    }
    dense.push(B)
  }

  // Step 3: accumulate cumulative distance over the dense track
  let cumDist = 0
  const track: { lat: number; lon: number; dist: number }[] = [{ ...dense[0], dist: 0 }]
  for (let i = 1; i < dense.length; i++) {
    cumDist += haversineNm(dense[i - 1].lat, dense[i - 1].lon, dense[i].lat, dense[i].lon)
    track.push({ ...dense[i], dist: cumDist })
  }

  const total_dist_nm = Math.round(cumDist * 10) / 10

  // Sample at evenly-spaced fractions
  const waypoints: { lat: number; lon: number; f: number }[] = []

  for (let i = 0; i < numWaypoints; i++) {
    const targetF    = i / (numWaypoints - 1)
    const targetDist = targetF * cumDist

    // Find track point closest to targetDist
    let best     = track[0]
    let bestErr  = Math.abs(track[0].dist - targetDist)
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

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const fr24_id  = searchParams.get('fr24_id')
  const dep_iata = searchParams.get('dep_iata')
  const arr_iata = searchParams.get('arr_iata')
  const save     = searchParams.get('save') === 'true'
  const num      = parseInt(searchParams.get('waypoints') ?? '20', 10)

  if (!fr24_id || !dep_iata || !arr_iata) {
    return NextResponse.json(
      { error: 'Required: fr24_id, dep_iata, arr_iata' },
      { status: 400 }
    )
  }

  let raw: object[]
  try {
    raw = await fetchTrail(fr24_id)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 })
  }

  let result: ReturnType<typeof buildWaypoints>
  try {
    result = buildWaypoints(raw, Math.min(Math.max(num, 5), 50))
  } catch (e) {
    return NextResponse.json({
      error: String(e),
      raw_count: raw.length,
      // Return a sample of raw positions to debug the field names
      sample: raw.slice(0, 3),
    }, { status: 422 })
  }

  const { waypoints, total_dist_nm, airborne_count } = result

  // Anchor last waypoint to actual arrival airport coords
  const apRes = await fetch(
    `${SB_URL}/rest/v1/airports?iata=eq.${arr_iata}&select=lat,lon`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
  )
  if (apRes.ok) {
    const rows: { lat: number; lon: number }[] = await apRes.json()
    if (rows[0]) {
      waypoints[waypoints.length - 1] = { lat: rows[0].lat, lon: rows[0].lon, f: 1.0 }
    }
  }

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
    raw_positions:   raw.length,
    airborne_count,
    total_dist_nm,
    waypoints_count: waypoints.length,
    waypoints,
    saved:           save,
  })
}

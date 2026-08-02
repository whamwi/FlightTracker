// UNSCHEDULED as of 2026-08-02 — deliberately kept, not deleted.
//
// OpenSky blocks Vercel's egress at the IP level: from a production function both
// opensky-network.org and auth.opensky-network.org (one host, 194.209.200.34) fail after
// ~10 s while a control host answers in 347 ms, and the same request from a home connection
// answers in 0.43 s. So this route is correct code that cannot succeed where it is deployed,
// and leaving it on a schedule only burned invocations against a black hole.
//
// It is removed from vercel.json rather than from the repo because it becomes useful the
// moment the poll runs from an egress OpenSky accepts (a container host, or the Damascus
// ADS-B Pi). Nothing else needs to change when that happens: this writes only to Supabase,
// and /api/airspace's fetchLoggedPositions only reads from Supabase.
import { NextResponse } from 'next/server'
import { queryStates, creditCost, hasCredentials, type StateVec, type BBox } from '@/lib/opensky'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

// Syria + neighbours bounding box (catches approaches / departures).
// 12° × 21° = 252 sq° → 3 credits, i.e. three quarters of every poll's cost.
const BBOX: BBox = { lamin: 28, lomin: 29, lamax: 40, lomax: 50 }

// The bbox sweep is off by default. writeState only persists aircraft that appear in our
// hex list, so every non-tracked aircraft the sweep returns is discarded — it currently
// buys nothing and costs 3 of the 4 credits per poll. Set OPENSKY_BBOX_POLL=1 to re-enable
// it once something consumes general traffic (e.g. an OpenSky-backed "Over Syria" view).
const BBOX_ENABLED = process.env.OPENSKY_BBOX_POLL === '1'

interface ActiveFlight {
  callsign:    string
  hex:         string
  flight_date: string
  dep_iata:    string | null
  arr_iata:    string | null
}

async function writeState(sv: StateVec, flight: ActiveFlight | undefined, now: string, today: string) {
  const callsign    = sv.callsign || flight?.callsign
  if (!callsign) return

  const flight_date = flight?.flight_date ?? today
  const airborne    = !sv.on_ground && (sv.alt_ft ?? 0) > 500 && (sv.gs_kts ?? 0) > 50

  // Position row — only for tracked flights (those with a known hex), airborne only
  if (airborne && flight) {
    await fetch(`${SB_URL}/rest/v1/flight_position_log`, {
      method:  'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({
        callsign, flight_date, captured_at: now,
        lat:      sv.lat,
        lon:      sv.lon,
        alt_baro: sv.alt_ft,
        gs:       sv.gs_kts,
        track:    sv.track,
        hex:      sv.icao24,
        dep_iata: flight?.dep_iata ?? null,
        arr_iata: flight?.arr_iata ?? null,
      }),
    })
  }

  // Milestone update — only for flights we're tracking (in our hex list)
  if (!flight) return

  const sumRes = await fetch(
    `${SB_URL}/rest/v1/flight_signal_log`
    + `?callsign=eq.${encodeURIComponent(callsign)}&flight_date=eq.${flight_date}`
    + `&select=airborne_at,actual_arr_at`,
    { headers: HEADERS }
  )
  const rows = sumRes.ok ? (await sumRes.json() as Record<string, string | null>[]) : []
  const ex   = rows[0] ?? null

  const airborne_at   = ex?.airborne_at   ?? (airborne ? now : null)
  // Mark landed if: previously seen airborne, now on ground or very slow + very low
  const justLanded    = !!ex?.airborne_at && !ex.actual_arr_at
                     && (sv.on_ground || ((sv.alt_ft ?? 999) < 100 && (sv.gs_kts ?? 999) < 30))
  const actual_arr_at = ex?.actual_arr_at ?? (justLanded ? now : null)

  await fetch(`${SB_URL}/rest/v1/flight_signal_log`, {
    method:  'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      callsign, flight_date,
      hex:          sv.icao24,
      dep_iata:     flight.dep_iata,
      arr_iata:     flight.arr_iata,
      last_seen_at: now,
      ...(airborne_at   ? { airborne_at }   : {}),
      ...(actual_arr_at ? { actual_arr_at } : {}),
    }),
  })
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = req.headers.get('Authorization') ?? req.headers.get('x-cron-secret') ?? ''
    if (auth !== `Bearer ${secret}` && auth !== secret) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }
  }

  if (!hasCredentials()) {
    return NextResponse.json(
      { ok: false, error: 'no OpenSky credentials (OPENSKY_CLIENT_ID/SECRET or OPENSKY_USER/PASS)' },
      { status: 503 },
    )
  }

  const now   = new Date().toISOString()
  const today = now.slice(0, 10)

  // 1. Active flights with known hex codes
  const activeRes = await fetch(
    `${SB_URL}/rest/v1/flight_signal_log`
    + `?flight_date=eq.${today}&actual_arr_at=is.null&hex=not.is.null`
    + `&select=callsign,hex,flight_date,dep_iata,arr_iata`,
    { headers: HEADERS }
  )
  const active: ActiveFlight[] = activeRes.ok ? await activeRes.json() : []
  const hexMap = new Map<string, ActiveFlight>()
  for (const f of active) hexMap.set(f.hex.toLowerCase(), f)

  const errors: string[] = []
  let credits = 0

  // 2. Hex batch — tracks our flights anywhere in the world, 1 credit for the whole list
  let hexStates: StateVec[] = []
  if (hexMap.size > 0) {
    const r = await queryStates({ icao24: [...hexMap.keys()] })
    hexStates = r.states
    credits  += r.credits
    if (!r.ok) errors.push(`hex: ${r.error}`)
  }

  // 3. Bounding box — all traffic over Syria + neighbours (see BBOX_ENABLED)
  let bboxStates: StateVec[] = []
  if (BBOX_ENABLED) {
    const r = await queryStates({ bbox: BBOX })
    bboxStates = r.states
    credits   += r.credits
    if (!r.ok) errors.push(`bbox: ${r.error}`)
  }

  // 4. Merge — hex batch wins on conflict (same icao24 in both responses)
  const merged = new Map<string, StateVec>()
  for (const sv of bboxStates) merged.set(sv.icao24, sv)
  for (const sv of hexStates)  merged.set(sv.icao24, sv)

  // 5. Write positions + milestones concurrently
  const writes = await Promise.allSettled(
    [...merged.values()].map(sv => writeState(sv, hexMap.get(sv.icao24), now, today))
  )
  const writeFailures = writes.filter(w => w.status === 'rejected').length

  return NextResponse.json({
    // A poll that reached OpenSky and found nothing is a success; one that failed to reach
    // it is not. The old route returned ok:true either way, which is why a broken feed
    // looked identical to empty sky.
    ok:            errors.length === 0,
    polled_at:     now,
    active_hexes:  hexMap.size,
    hex_found:     hexStates.length,
    bbox_enabled:  BBOX_ENABLED,
    bbox_found:    bboxStates.length,
    total:         merged.size,
    credits,
    credits_if_bbox_enabled: credits + (BBOX_ENABLED ? 0 : creditCost({ bbox: BBOX })),
    write_failures: writeFailures,
    errors,
  })
}

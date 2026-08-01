import { NextResponse } from 'next/server'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

// Syria + neighbours bounding box (catches approaches / departures)
const BBOX = { lamin: '28', lomin: '29', lamax: '40', lomax: '50' }

const MS_TO_KTS = 1.94384
const M_TO_FT   = 3.28084

interface ActiveFlight {
  callsign:    string
  hex:         string
  flight_date: string
  dep_iata:    string | null
  arr_iata:    string | null
}

interface StateVec {
  icao24:    string
  callsign:  string
  lat:       number
  lon:       number
  alt_ft:    number | null
  gs_kts:    number | null
  track:     number | null
  on_ground: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseState(s: any[]): StateVec | null {
  if (s[6] == null || s[5] == null) return null
  return {
    icao24:    (s[0] as string).toLowerCase(),
    callsign:  ((s[1] as string) || '').trim(),
    lat:       s[6] as number,
    lon:       s[5] as number,
    alt_ft:    s[7] != null ? Math.round((s[7] as number) * M_TO_FT)   : null,
    gs_kts:    s[9] != null ? Math.round((s[9] as number) * MS_TO_KTS) : null,
    track:     s[10] as number | null,
    on_ground: Boolean(s[8]),
  }
}

function openskyAuthHeader(): string | null {
  const user = process.env.OPENSKY_USER
  const pass = process.env.OPENSKY_PASS
  if (!user || !pass) return null
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
}

async function queryOpenSky(
  params: Record<string, string>,
  debug?: string[],
): Promise<StateVec[]> {
  const qs   = new URLSearchParams(params).toString()
  const auth = openskyAuthHeader()
  let res: Response
  try {
    res = await fetch(`https://opensky-network.org/api/states/all?${qs}`, {
      headers: {
        'User-Agent':    'FlightTracker/1.0',
        ...(auth ? { Authorization: auth } : {}),
      },
      signal: AbortSignal.timeout(12_000),
    })
  } catch (e) {
    debug?.push(`fetch error: ${e}`)
    return []
  }
  debug?.push(`HTTP ${res.status} (auth=${!!auth})`)
  if (res.status === 429) return []
  if (!res.ok) {
    debug?.push(await res.text().catch(() => ''))
    return []
  }
  const data = await res.json() as { states?: unknown[][] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.states ?? []).flatMap(s => { const v = parseState(s as any[]); return v ? [v] : [] })
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

  // 2. Hex batch — tracks our flights anywhere in the world
  const dbg: string[] = []
  let hexStates: StateVec[] = []
  if (hexMap.size > 0) {
    hexStates = await queryOpenSky({ icao24: [...hexMap.keys()].join(',') }, dbg)
  }

  // 3. Bounding box — all traffic over Syria + neighbours (feeds "Over Syria" view)
  const bboxStates = await queryOpenSky(BBOX, dbg)

  // 4. Merge — hex batch wins on conflict (same icao24 in both responses)
  const merged = new Map<string, StateVec>()
  for (const sv of bboxStates) merged.set(sv.icao24, sv)
  for (const sv of hexStates)  merged.set(sv.icao24, sv)

  // 5. Write positions + milestones concurrently
  await Promise.allSettled(
    [...merged.values()].map(sv => writeState(sv, hexMap.get(sv.icao24), now, today))
  )

  return NextResponse.json({
    ok:           true,
    polled_at:    now,
    active_hexes: hexMap.size,
    hex_found:    hexStates.length,
    bbox_found:   bboxStates.length,
    total:        merged.size,
    debug:        dbg,
  })
}

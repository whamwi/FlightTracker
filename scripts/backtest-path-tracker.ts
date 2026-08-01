/**
 * Replays recorded ADS-B streams from flight_position_log through PathTracker and
 * compares it against the naive model the map uses today (hold the last fix, snap to the
 * next one when it arrives).
 *
 * Run:  node --experimental-strip-types --env-file=.env.local scripts/backtest-path-tracker.ts
 *
 * Two methodology points, both learned the hard way:
 *
 *  - Smoothness must be sampled at DISPLAY cadence, not at fix times. The recorded fixes
 *    are minutes to hours apart, so measuring movement between them measures the sampling
 *    gap, not the motion a user would see.
 *
 *  - The ETA must not come from the actual landing time. That is hindsight, and it makes
 *    "did it arrive on time" true by construction. Scheduled duration from route_master is
 *    what would genuinely have been known during the flight.
 */

import { PathTracker, PathGeometry, type PathContext } from '../lib/path-tracker.ts'
import { haversineKm, type Waypoint } from '../lib/flight-predictor.ts'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const MIN_FIXES  = 10
const FRAME_MS   = 10_000        // display cadence being simulated

type Row = Record<string, any>   // eslint-disable-line @typescript-eslint/no-explicit-any

async function sb(path: string): Promise<Row[]> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H })
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`)
  return res.json()
}

const pad = (n: number, w: number, d = 1) => n.toFixed(d).padStart(w)
const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function main() {
  const paths  = await sb('route_paths?select=dep_iata,arr_iata,waypoints')
  const signal = await sb('flight_signal_log?select=callsign,flight_date,dep_iata,arr_iata,airborne_at,actual_arr_at')
  const rmaster= await sb('route_master?select=dep_iata,arr_iata,duration_min')
  const pos    = await sb('flight_position_log?select=callsign,flight_date,captured_at,lat,lon,alt_baro,gs,track&order=captured_at.asc&limit=10000')

  const pathBy = new Map(paths.map(p => [`${p.dep_iata}-${p.arr_iata}`, p.waypoints as Waypoint[]]))
  const sigBy  = new Map(signal.map(s => [`${s.callsign}|${s.flight_date}`, s]))

  // Scheduled duration per OD pair — known at flight time, unlike the landing time.
  const durBy = new Map<string, number>()
  for (const r of rmaster) {
    if (r.duration_min) durBy.set(`${r.dep_iata}-${r.arr_iata}`, r.duration_min)
  }

  const flights = new Map<string, Row[]>()
  for (const r of pos) {
    const k = `${r.callsign}|${r.flight_date}`
    if (!flights.has(k)) flights.set(k, [])
    flights.get(k)!.push(r)
  }

  console.log('flight              route   fixes acc rej | max frame jump km  | mono | arr err | med off-path')
  console.log('                                          | tracker     naive |      |         | acc / rej')
  console.log('─'.repeat(100))

  let nT = 0, nN = 0, nV = 0, nF = 0, arrErrs: number[] = []

  for (const [key, fixesRaw] of [...flights.entries()].sort()) {
    const fixes = fixesRaw.filter(f => f.lat != null && f.lon != null)
    if (fixes.length < MIN_FIXES) continue

    const sig = sigBy.get(key)
    if (!sig?.dep_iata || !sig?.arr_iata) continue
    const od  = `${sig.dep_iata}-${sig.arr_iata}`
    const wps = pathBy.get(od)
    if (!wps || wps.length < 2) continue

    const t0 = new Date(sig.airborne_at ?? fixes[0].captured_at).getTime()
    const schedMin = durBy.get(od)
    if (!schedMin) continue
    const eta = t0 + schedMin * 60_000            // no hindsight
    const actualArr = sig.actual_arr_at ? new Date(sig.actual_arr_at).getTime() : null

    const ctx: PathContext = {
      waypoints: wps,
      dep_coords: [wps[0].lat, wps[0].lon],
      arr_coords: [wps[wps.length - 1].lat, wps[wps.length - 1].lon],
      departed_at_ms: t0,
      eta_ms: eta,
      duration_ms: schedMin * 60_000,
    }

    const geo     = new PathGeometry(wps)
    const tracker = new PathTracker(ctx, t0)
    let accepted = 0, rejected = 0, violations = 0
    let prevS = -1
    let prevT: [number, number] | null = null
    let prevN: [number, number] | null = null
    let maxT = 0, maxN = 0
    const offAcc: number[] = [], offRej: number[] = []

    // Simulate the display advancing frame by frame, delivering fixes as their time comes.
    const end = Math.max(actualArr ?? 0, fixes[fixes.length - 1].captured_at ? new Date(fixes[fixes.length - 1].captured_at).getTime() : eta, eta)
    let fi = 0
    let lastFix: Row | null = null

    for (let t = t0; t <= end; t += FRAME_MS) {
      // Deliver any fixes whose moment has arrived.
      while (fi < fixes.length && new Date(fixes[fi].captured_at).getTime() <= t) {
        const f = fixes[fi++]
        const at = new Date(f.captured_at).getTime()
        const { offPathKm } = geo.project(f.lat, f.lon)
        const out = tracker.applyFix(
          { lat: f.lat, lon: f.lon, at_ms: at, gs_kts: f.gs, track_deg: f.track, altitude_ft: f.alt_baro },
          t,
        )
        if (out.accepted) { accepted++; offAcc.push(offPathKm) } else { rejected++; offRej.push(offPathKm) }
        lastFix = f
      }

      const p = tracker.position(t)
      if (p.routeFraction < prevS - 1e-9) violations++
      prevS = p.routeFraction

      if (prevT) maxT = Math.max(maxT, haversineKm(prevT[0], prevT[1], p.lat, p.lon))
      prevT = [p.lat, p.lon]

      // Naive: whatever the last received fix said, held until the next one replaces it.
      if (lastFix) {
        if (prevN) maxN = Math.max(maxN, haversineKm(prevN[0], prevN[1], lastFix.lat, lastFix.lon))
        prevN = [lastFix.lat, lastFix.lon]
      }
    }

    // How far along was the tracker when the aircraft actually landed? 100% = perfect.
    let arrErr = NaN
    if (actualArr) {
      arrErr = (tracker.position(actualArr).routeFraction - 1) * 100
      arrErrs.push(Math.abs(arrErr))
    }

    console.log(
      `${key.padEnd(19)} ${od.padEnd(8)} ${String(fixes.length).padStart(4)} ${String(accepted).padStart(3)} ${String(rejected).padStart(3)} |` +
      `${pad(maxT, 8, 2)} ${pad(maxN, 9, 1)} |` +
      `${String(violations).padStart(5)} |` +
      `${Number.isNaN(arrErr) ? '     -  ' : pad(arrErr, 7, 0) + '%'} |` +
      ` ${pad(median(offAcc), 5)} / ${offRej.length ? pad(median(offRej), 5) : '    -'}` +
      `${geo.degeneracy() > 4 ? '  ⚠ truncated path' : ''}`,
    )

    nT += maxT; nN += maxN; nV += violations; nF++
  }

  console.log('─'.repeat(100))
  console.log(`flights: ${nF}`)
  console.log(`mean max frame-to-frame jump   tracker ${pad(nT / nF, 6, 2)} km   naive ${pad(nN / nF, 6, 1)} km`)
  console.log(`monotonicity violations: ${nV}`)
  console.log(`median |arrival error|: ${pad(median(arrErrs), 5, 1)}% of route`)
}

main().catch(e => { console.error(e); process.exit(1) })

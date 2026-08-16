/**
 * One answer to "where is this aeroplane", computed once, on the server.
 *
 * Every position defect this project has had was two implementations of this question
 * disagreeing: the site drawing FYC361 where its fix said and the phone drawing it 190 km away
 * on the corridor; a tracker seeded 298 km ahead closing to 61 km in one codebase and growing to
 * 440 km in the other; a countdown damped once by the server and again by the client, so the
 * site held 12:07 while the phone read 12:07, 12:09, 12:07. The values were rarely in dispute.
 * The number of opinions was.
 *
 * So this module is deliberately the whole answer, and deliberately PURE. Given a flight, its
 * corridor and an instant, it returns a position — no accumulated progress scalar, no rate, no
 * chasing flag, no correction factor. Those exist in the client trackers only because they carry
 * state between polls, and carried state is what drifts, both from reality and from the other
 * surface's copy of it. A function of (schedule, corridor, fix, now) cannot drift: two callers
 * asking at the same instant get the same answer because there is nothing else to get.
 *
 * The observed/inferred split is reported, never hidden. A reader is entitled to know whether an
 * aeroplane is where we saw it or where we believe it should be, and the client needs it to fade
 * a marker.
 */

import { interpolatePath, bearingFromPath, type Waypoint } from './flight-predictor.ts'

export type PositionSource = 'observed' | 'inferred'

export interface ResolvedPosition {
  lat: number
  lon: number
  track: number
  source: PositionSource
  /** Seconds since the observed fix. Always 0 for an inferred position. */
  fix_age_s: number
}

/**
 * A raw fix, in the shape both the ADS-B aggregators and our own receiver produce.
 * Loose on purpose: this is the boundary where untrusted data arrives.
 */
export interface RawFix {
  hex?: string | null
  lat?: unknown
  lon?: unknown
  alt_baro?: unknown
  gs?: unknown
  track?: unknown
}

/** Altitude above which an aircraft is unambiguously airborne rather than parked. */
const AIRBORNE_FT = 10_000
/** No aircraft holds 10,000 ft below this. Stalling speeds are far above it. */
const MIN_AIRBORNE_KT = 50

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/**
 * Is this fix physically possible?
 *
 * On 15 and 16 Aug the aggregator served 47 distinct aircraft — Qatar, Turkish, Saudia, Jazeera,
 * flyadeal, MEA, Condor, flydubai — every one of them stamped 31.71711, 35.999341 with `gs 0.7`
 * and `track 0`, while their altitudes stayed real and distinct: 39,000, 37,025, 33,000 ft. The
 * raw records carried identical `dst` and `dir` too, so upstream had computed both from a
 * constant. Only the position and velocity fields were replaced; `ias`, `mach` and `true_heading`
 * were genuine throughout.
 *
 * Those coordinates are Queen Alia airport, Amman, which is inside the region box — so the only
 * filter on the path waved them through, they were stored, and both surfaces drew a dozen
 * airliners parked on top of each other in Jordan.
 *
 * A cruising aircraft reporting 0.7 knots is not a slow aircraft; it is a null wearing a number.
 * Nothing here hardcodes Amman: the next sentinel will be somewhere else.
 */
export function isPlausibleFix(fix: RawFix): boolean {
  const lat = num(fix.lat)
  const lon = num(fix.lon)
  if (lat === null || lon === null) return false
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false
  // 0,0 is the Atlantic, and far more often an uninitialised pair than a real position.
  if (lat === 0 && lon === 0) return false

  const alt = num(fix.alt_baro)
  const gs  = num(fix.gs)
  if (alt !== null && gs !== null && alt > AIRBORNE_FT && gs < MIN_AIRBORNE_KT) return false

  return true
}

/** Five decimal places is about a metre — far finer than two aircraft ever genuinely share. */
const key = (lat: number, lon: number) => `${lat.toFixed(5)},${lon.toFixed(5)}`

/**
 * Discard coordinates that more than one aircraft claims at the same time.
 *
 * The physics guard above catches a sentinel that also clobbers speed. It does not catch one
 * that leaves speed intact — PER002 came back from the same corrupt sweep at `gs 456`, entirely
 * plausible on its own, and still sitting on Queen Alia with nineteen others.
 *
 * Two aircraft do not occupy the same square metre. When a coordinate is claimed by two distinct
 * airframes in one sweep it is a placeholder, and every row carrying it is discarded — including
 * the one that might have been real, because there is no way to tell which. Self-tuning, and it
 * costs nothing when the feed is healthy.
 */
export function dropSentinelFixes<T extends RawFix>(fixes: T[]): T[] {
  const hexesAt = new Map<string, Set<string>>()
  for (const f of fixes) {
    const lat = num(f.lat), lon = num(f.lon)
    if (lat === null || lon === null) continue
    const k = key(lat, lon)
    let set = hexesAt.get(k)
    if (!set) hexesAt.set(k, set = new Set())
    // Rows without a hex still count as one claimant each; a feed that omits hex should not be
    // able to hide a sentinel behind a single empty identity.
    set.add(f.hex ?? `anon:${set.size}`)
  }
  return fixes.filter(f => {
    const lat = num(f.lat), lon = num(f.lon)
    if (lat === null || lon === null) return true   // nothing to judge; the guard above handles it
    return (hexesAt.get(key(lat, lon))?.size ?? 0) < 2
  })
}

/**
 * Where a flight should be, from its schedule and its corridor.
 *
 * The whole of the inference, and it is four lines: how far through the flight are we, where is
 * that on the path, which way does the path point there.
 *
 * `depMs`/`arrMs` are the instants the flight actually left and is expected to arrive — the
 * caller passes `actual_dep_utc` and the stabilised arrival, so a delay that has already been
 * absorbed into the ETA slows the aeroplane down here rather than teleporting it on arrival.
 *
 * Returns null rather than a guess when the inputs cannot support one. A missing corridor is
 * handled by the caller, which supplies a two-point great circle: `interpolatePath` treats that
 * identically, so there is no second code path for it.
 */
export function inferPosition(
  depMs: number,
  arrMs: number,
  path: Waypoint[],
  nowMs: number,
): ResolvedPosition | null {
  if (!Number.isFinite(depMs) || !Number.isFinite(arrMs) || arrMs <= depMs) return null
  if (!path.length) return null

  const f = Math.min(1, Math.max(0, (nowMs - depMs) / (arrMs - depMs)))
  const [lat, lon] = interpolatePath(path, f)
  return { lat, lon, track: bearingFromPath(path, f), source: 'inferred', fix_age_s: 0 }
}

/**
 * A two-point corridor between airports, for an OD pair we have never recorded a path for.
 *
 * Deliberately the same `Waypoint[]` shape as a real corridor so the caller cannot end up with
 * two ways of asking the same question.
 */
export function greatCirclePath(
  depLat: number, depLon: number, arrLat: number, arrLon: number,
): Waypoint[] {
  return [
    { lat: depLat, lon: depLon, f: 0 },
    { lat: arrLat, lon: arrLon, f: 1 },
  ]
}

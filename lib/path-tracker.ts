/**
 * Path-anchored flight tracking.
 *
 * The existing FlightPredictor treats live ADS-B as the truth and predicts only to fill
 * gaps. Over Syria that inverts badly: coverage is intermittent and GPS jamming produces
 * fixes that are not merely late but wrong, so a position-led model shows aircraft
 * jumping backwards and forwards along their route.
 *
 * Here the aircraft's state is a single scalar — `s`, its fraction along the known route
 * path — advanced by a rate `v`. Live fixes never assign position. They only nudge `v`,
 * within clamps that keep motion forward and continuous. A fix that disagrees makes the
 * aircraft gradually catch up or ease off; a fix that never arrives changes nothing.
 *
 * That gives three properties the old model could not:
 *   - a missing fix is a non-event, so aircraft cannot vanish
 *   - `s` is monotonic, so aircraft cannot reverse
 *   - `v` is bounded, so corrections cannot present as jumps
 *
 * The primary rate signal is not ADS-B at all: it is the arrival estimate, which arrives
 * via the schedule feed and is revised during the flight. `v_nominal` is simply "remaining
 * path divided by remaining time", so a flight with zero position fixes still arrives when
 * the airline says it will.
 *
 * Geometry is imported from flight-predictor rather than reimplemented — those helpers are
 * covered by an existing suite, and a third copy of them (Map.tsx already holds a second)
 * would be one more thing to drift.
 */

import {
  haversineKm,
  interpolatePath,
  bearingFromPath,
  slerpGC,
  type Waypoint,
} from './flight-predictor.ts'

/** Points used when synthesising a stand-in route. */
const SYNTH_POINTS = 21

/**
 * Great-circle path between two airports, for OD pairs with no stored route.
 *
 * Six scheduled pairs currently have none, and three more are truncated. Without this the
 * tracker rejects every fix as `no_path` and falls back to interpolating latitude and
 * longitude linearly — which is not even a great circle, and is badly wrong over a
 * distance like DAM–BER. A synthesised path is geometrically approximate but lets
 * projection, correction and the off-path test all work normally.
 *
 * Sampling evenly in great-circle parameter also spaces the points evenly in distance, so
 * index-proportional `f` and distance-proportional progress coincide here.
 */
export function synthesizePath(
  dep: [number, number], arr: [number, number], n = SYNTH_POINTS,
): Waypoint[] {
  const out: Waypoint[] = []
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    const [lat, lon] = slerpGC(dep[0], dep[1], arr[0], arr[1], t)
    out.push({ f: t, lat, lon })
  }
  return out
}

// ── Path projection ───────────────────────────────────────────────────────────

const DEG        = Math.PI / 180
const KM_PER_DEG = 111.194927

/**
 * Distance-aware view of a stored route path.
 *
 * The stored `f` on each waypoint is index-proportional — waypoint i carries f = i/(n-1)
 * regardless of spacing — while actual segments range from 3 km to over 500 km. Measured
 * across the 61 well-formed paths, that makes `f` diverge from true distance-fraction by
 * a median of 2.6% and up to 15.7%, which on a long route is nearly 200 km. Driving the
 * tracker off `f` directly would therefore make aircraft speed up and slow down according
 * to where waypoints happen to fall, and would leave `v` with no physical meaning.
 *
 * So progress is expressed as a fraction of *distance*, and converted to waypoint-space
 * only when calling the geometry helpers. Cumulative distance is derived here rather than
 * stored: it is a handful of haversines, and a persisted copy could fall out of step with
 * the waypoints it came from.
 */
export class PathGeometry {
  readonly totalKm: number
  private wps: Waypoint[]
  /** Cumulative km at each waypoint. */
  private cum: number[]

  constructor(wps: Waypoint[]) {
    this.wps = wps
    this.cum = [0]
    let acc = 0
    for (let i = 0; i < wps.length - 1; i++) {
      acc += haversineKm(wps[i].lat, wps[i].lon, wps[i + 1].lat, wps[i + 1].lon)
      this.cum.push(acc)
    }
    this.totalKm = acc
  }

  get usable(): boolean {
    return this.wps.length >= 2 && this.totalKm > 0
  }

  /** Distance fraction → the index-space f that interpolatePath expects. */
  toPathF(sDist: number): number {
    if (!this.usable) return 0
    const target = clamp(sDist, 0, 1) * this.totalKm

    let lo = 0, hi = this.cum.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (this.cum[mid] <= target) lo = mid; else hi = mid
    }
    const span = this.cum[hi] - this.cum[lo]
    const t = span < 1e-9 ? 0 : (target - this.cum[lo]) / span
    return this.wps[lo].f + t * (this.wps[hi].f - this.wps[lo].f)
  }

  positionAt(sDist: number): [number, number] {
    return interpolatePath(this.wps, this.toPathF(sDist))
  }

  bearingAt(sDist: number): number {
    return bearingFromPath(this.wps, this.toPathF(sDist))
  }

  /**
   * Closest point on the route to (lat, lon), as a distance fraction plus cross-track km.
   *
   * flight-predictor's `nearestPathFraction` is deliberately not used: it snaps to the
   * nearest *waypoint*, so with waypoints a hundred kilometres apart it reports positions
   * far from the aircraft and quantises progress into huge steps. Fine for that module's
   * coarse checks; useless as the error term of a rate-correction law.
   *
   * Each segment is projected in a local equirectangular frame — well under a kilometre of
   * error at these lengths — and the winner's true offset is measured with haversine.
   */
  project(lat: number, lon: number): { sDist: number; offPathKm: number } {
    if (!this.usable) return { sDist: 0, offPathKm: Infinity }

    let bestS = 0, bestKm = Infinity

    for (let i = 0; i < this.wps.length - 1; i++) {
      const a = this.wps[i], b = this.wps[i + 1]
      const kx = Math.cos(((a.lat + b.lat) / 2) * DEG) * KM_PER_DEG

      const ax = a.lon * kx, ay = a.lat * KM_PER_DEG
      const bx = b.lon * kx, by = b.lat * KM_PER_DEG
      const px = lon   * kx, py = lat   * KM_PER_DEG

      const dx = bx - ax, dy = by - ay
      const len2 = dx * dx + dy * dy
      const t = len2 < 1e-9 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1)

      const sDist = (this.cum[i] + t * (this.cum[i + 1] - this.cum[i])) / this.totalKm
      const [cLat, cLon] = this.positionAt(sDist)
      const km = haversineKm(lat, lon, cLat, cLon)
      if (km < bestKm) { bestKm = km; bestS = sDist }
    }

    return { sDist: bestS, offPathKm: bestKm }
  }

  /**
   * Largest ratio of a segment's distance share to its fraction share.
   *
   * Three stored paths (ALP-SHJ, DAM-AMS, DAM-MCT) are truncated: the recorded track stops
   * where coverage ran out and the destination is tacked on, packing about half the route
   * into the final 5%. All three are flagged is_validated. A high value here means the
   * geometry between those points is fiction, even though motion along it stays smooth.
   */
  degeneracy(): number {
    if (!this.usable) return Infinity
    let worst = 0
    for (let i = 0; i < this.wps.length - 1; i++) {
      const df = this.wps[i + 1].f - this.wps[i].f
      if (df <= 0) continue
      const share = (this.cum[i + 1] - this.cum[i]) / this.totalKm
      worst = Math.max(worst, share / df)
    }
    return worst
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type PathMode = 'path' | 'diverged'

/** Why a fix was not applied. Recorded rather than discarded — the counts are the
 *  coverage and jamming telemetry we currently have no visibility into. */
export type RejectReason = 'off_path' | 'impossible_speed' | 'backward' | 'stale' | 'no_path'

export interface PathFix {
  lat:          number
  lon:          number
  at_ms:        number
  gs_kts?:      number | null
  track_deg?:   number | null
  altitude_ft?: number | null
  source?:      string
}

export interface PathContext {
  /**
   * One entry per known corridor for this OD pair, ordered most-observed first.
   *
   * Most routes have exactly one. IST-DAM has two — northern via Ankara and a
   * southwestern diagonal, 282 km apart and both flown daily — and with a single stored
   * path the other corridor's flights read as 200 km off route, which is
   * indistinguishable from a spoofed position.
   */
  variants:       Waypoint[][]
  dep_coords:     [number, number]
  arr_coords:     [number, number]
  /** Confirmed wheels-up. Anchors s = 0. */
  departed_at_ms: number | null
  /** Current best arrival estimate — revised_arr_utc when present, else scheduled.
   *  This is the primary rate input and is expected to change mid-flight. */
  eta_ms:         number | null
  /** Fallback when no ETA is known at all. */
  duration_ms:    number | null
}

export interface PathConfig {
  /** Time over which a position disagreement is absorbed. Larger = gentler. */
  correctionHorizonMs: number
  /** Rate clamps, as multiples of nominal. Lower bound > 0 forbids reversing. */
  minRateFactor: number
  maxRateFactor: number
  /** A fix further than this from the path is not believed. */
  maxOffPathKm: number
  /** Implied ground speed above this between two fixes means one of them is wrong. */
  maxImpliedGsKts: number
  /** Backward disagreement tolerated without corroboration, as a path fraction. */
  backwardToleranceS: number
  /** Consecutive agreeing fixes needed before a backward correction is believed. */
  backwardConfirmCount: number
  /** Consecutive off-path fixes before concluding the aircraft is not on the route. */
  divergenceCount: number
  /** Never divide by less than this when deriving nominal rate. */
  minRemainingMs: number
  /** Fixes older than this are ignored on arrival. */
  maxFixAgeMs: number
  /** A rival corridor must fit this many times better before the flight switches to it. */
  variantSwitchMargin: number
  /**
   * Progress past which the corridor is locked in.
   *
   * Corridors share their endpoints and fan apart in the middle, so a late switch means
   * moving the aircraft across the full gap between them — 282 km on IST-DAM, which is a
   * teleport by any measure. Early on the two are still close, so the same decision costs
   * tens of kilometres instead of hundreds.
   */
  variantLockS: number
  /** Time over which a corridor change is glided rather than jumped. */
  variantTransitionMs: number
}

export const DEFAULT_PATH_CONFIG: Readonly<PathConfig> = {
  correctionHorizonMs:   5 * 60_000,
  minRateFactor:         0.5,
  maxRateFactor:         1.6,
  maxOffPathKm:          40,
  maxImpliedGsKts:       700,
  backwardToleranceS:    0.01,
  backwardConfirmCount:  2,
  divergenceCount:       3,
  minRemainingMs:        60_000,
  maxFixAgeMs:           30 * 60_000,
  variantSwitchMargin:   2,
  variantLockS:          0.3,
  variantTransitionMs:   60_000,
}

export interface PathPosition {
  lat:           number
  lon:           number
  track_deg:     number
  routeFraction: number
  mode:          PathMode
  /** True whenever the shown position is not a recent live fix. */
  isEstimated:   boolean
  /** ms since the last accepted fix; null if none has ever been accepted. */
  fixAgeMs:      number | null
  altitude_ft:   number | null
}

export interface FixOutcome {
  accepted: boolean
  reason:   RejectReason | null
  /** Signed disagreement in path fraction: positive means the fix was ahead of us. */
  errorS:   number | null
}

// ── Tracker ───────────────────────────────────────────────────────────────────

export class PathTracker {
  private cfg: PathConfig
  private ctx: PathContext

  /** Progress as a fraction of route DISTANCE, not of waypoint index. */
  private s = 0
  /** Distance fraction per millisecond — i.e. a ground speed, once scaled by totalKm. */
  private v = 0
  private lastAdvanceMs: number

  private lastAcceptedFix: PathFix | null = null
  private lastAcceptedMs: number | null = null
  private lastAltitudeFt: number | null = null

  private backwardStreak = 0
  private offPathStreak  = 0
  private mode: PathMode = 'path'

  /** One geometry per known corridor. Usually length 1. */
  private geos: PathGeometry[]
  /** Cumulative off-path distance and sample count, per corridor. */
  private offSum: number[]
  private offN:   number[]
  /** Index of the corridor currently believed to be in use. */
  private active = 0
  private switches = 0
  /** Corridor being glided away from, and when the glide began. */
  private transitionFrom: number | null = null
  private transitionAtMs = 0

  /** True when no stored path existed and a great circle was substituted. */
  readonly synthesized: boolean

  /** The corridor driving position and correction right now. */
  private get geo(): PathGeometry { return this.geos[this.active] }

  /** Rejection tallies, surfaced for telemetry. */
  readonly rejects: Record<RejectReason, number> = {
    off_path: 0, impossible_speed: 0, backward: 0, stale: 0, no_path: 0,
  }

  constructor(ctx: PathContext, nowMs: number, cfg: PathConfig = DEFAULT_PATH_CONFIG) {
    this.cfg = cfg
    this.ctx = ctx
    this.lastAdvanceMs = nowMs

    // Fall back to a great circle rather than going path-less, so routes with no stored
    // waypoints still get projection and rate correction instead of rejecting every fix.
    const stored = (ctx.variants ?? []).filter(v => v && v.length >= 2)
    this.synthesized = stored.length === 0
    this.geos = this.synthesized
      ? [new PathGeometry(synthesizePath(ctx.dep_coords, ctx.arr_coords))]
      : stored.map(v => new PathGeometry(v))
    this.offSum = this.geos.map(() => 0)
    this.offN   = this.geos.map(() => 0)

    // A flight already underway when the tracker is created starts at the fraction its
    // elapsed time implies, so a server restart doesn't rewind every aircraft to zero.
    if (ctx.departed_at_ms != null) {
      const total = this.totalDurationMs()
      if (total > 0) {
        this.s = clamp((nowMs - ctx.departed_at_ms) / total, 0, 1)
      }
    }
    this.v = this.nominalRate(nowMs)
  }

  // ── Rate ────────────────────────────────────────────────────────────────────

  private totalDurationMs(): number {
    const { departed_at_ms, eta_ms, duration_ms } = this.ctx
    if (departed_at_ms != null && eta_ms != null && eta_ms > departed_at_ms) {
      return eta_ms - departed_at_ms
    }
    return duration_ms ?? 0
  }

  /**
   * Fastest progress the aircraft could physically make, as a path fraction per ms.
   *
   * Without this, a flight that overruns its ETA divides remaining path by a floored
   * remainder and the rate spikes — the aircraft visibly races to the destination.
   * Backtesting caught exactly that on ALP-SHJ, at 17 km per 10-second frame.
   */
  private maxPhysicalRate(): number {
    if (!this.geo.usable) return Infinity
    const kmPerMs = (this.cfg.maxImpliedGsKts * 1.852) / 3_600_000
    return kmPerMs / this.geo.totalKm
  }

  /** Remaining path over remaining time — the signal that carries a flight with no fixes. */
  private nominalRate(nowMs: number): number {
    const remainingS = Math.max(0, 1 - this.s)
    const { eta_ms } = this.ctx

    let rate: number
    if (eta_ms != null) {
      const remainingMs = Math.max(eta_ms - nowMs, this.cfg.minRemainingMs)
      rate = remainingS / remainingMs
    } else {
      const total = this.totalDurationMs()
      rate = total > 0 ? 1 / total : 0
    }
    return Math.min(rate, this.maxPhysicalRate())
  }

  /** Apply a revised arrival estimate. Rate changes; position does not. */
  setEta(etaMs: number | null, nowMs: number): void {
    this.advance(nowMs)
    this.ctx = { ...this.ctx, eta_ms: etaMs }
    this.v = this.nominalRate(nowMs)
  }

  // ── Advance ─────────────────────────────────────────────────────────────────

  /** Integrate progress forward. Monotonic by construction: v is never negative. */
  advance(nowMs: number): void {
    const dt = nowMs - this.lastAdvanceMs
    this.lastAdvanceMs = nowMs
    if (dt <= 0) return

    this.s = clamp(this.s + this.v * dt, this.s, 1)

    // Re-derive nominal as the flight proceeds so a slipping ETA keeps taking effect
    // even while no fixes are arriving.
    const nominal = this.nominalRate(nowMs)
    const [lo, hi] = this.rateBounds(nominal)
    this.v = clamp(this.v, lo, hi)
  }

  /** Rate clamps: relative to nominal, but never above what the aircraft could fly. */
  private rateBounds(nominal: number): [number, number] {
    const lo = nominal * this.cfg.minRateFactor
    const hi = Math.max(lo, Math.min(nominal * this.cfg.maxRateFactor, this.maxPhysicalRate()))
    return [lo, hi]
  }

  // ── Fixes ───────────────────────────────────────────────────────────────────

  /**
   * Offer a live position. It is validated, and on acceptance adjusts the rate only.
   * Returns why it was rejected so callers can record coverage and jamming telemetry.
   */
  applyFix(fix: PathFix, nowMs: number): FixOutcome {
    this.advance(nowMs)

    if (!this.geo.usable) {
      return this.reject('no_path')
    }
    if (nowMs - fix.at_ms > this.cfg.maxFixAgeMs) {
      return this.reject('stale')
    }

    // Test against every known corridor, not just the active one. A fix that fits any of
    // them is a legitimate position; only one that fits none is genuinely off route. That
    // distinction is what stops an aircraft on a second, unmodelled corridor from looking
    // identical to a spoofed position.
    const proj = this.geos.map(g => g.project(fix.lat, fix.lon))
    const bestFit = proj.reduce((b, p, i) => (p.offPathKm < proj[b].offPathKm ? i : b), 0)
    const offPathKm = proj[bestFit].offPathKm

    if (offPathKm > this.cfg.maxOffPathKm) {
      this.offPathStreak++
      if (this.offPathStreak >= this.cfg.divergenceCount) this.mode = 'diverged'
      return this.reject('off_path')
    }

    // Score all corridors on every accepted-looking fix, then let the evidence choose.
    proj.forEach((p, i) => { this.offSum[i] += p.offPathKm; this.offN[i]++ })
    this.reconsiderVariant(nowMs)

    const sLive = proj[this.active].sDist

    // Could the aircraft have got here from the last believed position?
    if (this.lastAcceptedFix && this.lastAcceptedMs != null) {
      const dtH = (fix.at_ms - this.lastAcceptedMs) / 3_600_000
      if (dtH > 0) {
        const km  = haversineKm(this.lastAcceptedFix.lat, this.lastAcceptedFix.lon, fix.lat, fix.lon)
        const kts = (km / 1.852) / dtH
        if (kts > this.cfg.maxImpliedGsKts) return this.reject('impossible_speed')
      }
    }

    // A fix claiming we are well behind needs corroboration before it is believed —
    // one bad sample must not be able to stall an aircraft.
    const errorS = sLive - this.s
    if (errorS < -this.cfg.backwardToleranceS) {
      this.backwardStreak++
      if (this.backwardStreak < this.cfg.backwardConfirmCount) {
        return this.reject('backward', errorS)
      }
    } else {
      this.backwardStreak = 0
    }

    // Accepted.
    this.offPathStreak  = 0
    this.mode           = 'path'
    this.lastAcceptedFix = fix
    this.lastAcceptedMs  = fix.at_ms
    if (fix.altitude_ft != null) this.lastAltitudeFt = fix.altitude_ft

    // The correction itself: close the disagreement over the horizon, never by moving.
    const nominal  = this.nominalRate(nowMs)
    const target   = nominal + errorS / this.cfg.correctionHorizonMs
    const [lo, hi] = this.rateBounds(nominal)
    this.v = clamp(target, lo, hi)

    return { accepted: true, reason: null, errorS }
  }

  /**
   * Switch corridors when another fits materially better.
   *
   * Requires a clear margin rather than a bare minimum, so noise around two similar
   * corridors cannot make the flight oscillate between them. Where corridors genuinely
   * differ — IST-DAM's two are 282 km apart — one or two fixes settle it decisively.
   *
   * Progress carries across unchanged: `s` is a distance fraction and variants share
   * their endpoints, so the aircraft keeps its place along the route.
   */
  private reconsiderVariant(nowMs: number): void {
    if (this.geos.length < 2) return
    // Past the lock point the corridors have fanned too far apart to move between without
    // a teleport. A mismatch after this is divergence, not a wrong choice of corridor.
    if (this.s > this.cfg.variantLockS) return

    const mean = (i: number) => (this.offN[i] ? this.offSum[i] / this.offN[i] : Infinity)

    let challenger = this.active
    for (let i = 0; i < this.geos.length; i++) {
      if (mean(i) < mean(challenger)) challenger = i
    }
    if (challenger !== this.active
        && mean(challenger) * this.cfg.variantSwitchMargin < mean(this.active)) {
      this.transitionFrom  = this.active
      this.transitionAtMs  = nowMs
      this.active = challenger
      this.switches++
    }
  }

  private reject(reason: RejectReason, errorS: number | null = null): FixOutcome {
    this.rejects[reason]++
    return { accepted: false, reason, errorS }
  }

  // ── Output ──────────────────────────────────────────────────────────────────

  position(nowMs: number): PathPosition {
    this.advance(nowMs)

    const hasPath = this.geo.usable
    let [lat, lon] = hasPath
      ? this.geo.positionAt(this.s)
      : lerpCoords(this.ctx.dep_coords, this.ctx.arr_coords, this.s)

    let track = hasPath ? this.geo.bearingAt(this.s) : 0

    // Ease across a corridor change instead of cutting to it. Locking the choice early
    // keeps this gap small, but small is not zero and a cut would still read as a jump.
    if (this.transitionFrom != null) {
      const elapsed = nowMs - this.transitionAtMs
      if (elapsed >= this.cfg.variantTransitionMs) {
        this.transitionFrom = null
      } else {
        const raw = elapsed / this.cfg.variantTransitionMs
        const t   = raw * raw * (3 - 2 * raw)          // smoothstep: no velocity jolt at either end
        const [fLat, fLon] = this.geos[this.transitionFrom].positionAt(this.s)
        lat   = fLat + (lat - fLat) * t
        lon   = fLon + (lon - fLon) * t
        track = this.geos[this.transitionFrom].bearingAt(this.s) * (1 - t) + track * t
      }
    }

    const fixAgeMs = this.lastAcceptedMs == null ? null : nowMs - this.lastAcceptedMs

    return {
      lat, lon,
      track_deg:     track,
      routeFraction: this.s,
      mode:          this.mode,
      // Anything not backed by a fix inside the correction horizon is estimated.
      isEstimated:   fixAgeMs == null || fixAgeMs > this.cfg.correctionHorizonMs,
      fixAgeMs,
      altitude_ft:   this.lastAltitudeFt,
    }
  }

  /** Current state, for persistence across serverless invocations. */
  snapshot() {
    return {
      s: this.s, v: this.v, mode: this.mode,
      synthesized: this.synthesized,
      totalKm:     this.geo.totalKm,
      degeneracy:  this.geo.degeneracy(),
      variant:     this.active,
      variantCount: this.geos.length,
      variantSwitches: this.switches,
      variantMeanOffPathKm: this.geos.map((_, i) => (this.offN[i] ? this.offSum[i] / this.offN[i] : null)),
      lastAdvanceMs:  this.lastAdvanceMs,
      lastAcceptedMs: this.lastAcceptedMs,
      rejects:        { ...this.rejects },
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

function lerpCoords(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

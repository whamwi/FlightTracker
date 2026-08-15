/**
 * FlightPredictor — Hybrid dead-reckoning engine with smooth signal-loss recovery.
 *
 * Design principles
 * ─────────────────
 * 1. Hybrid weights   — kinematic DR fades into route-following as the outage grows.
 *                       No single source dominates for the full 60-minute window.
 * 2. Geodesic motion  — all position advances use great-circle math, never flat-Earth.
 * 3. Smooth recovery  — when live data returns, display blends from predicted→live
 *                       over a duration proportional to the prediction error.
 *                       The aircraft never teleports.
 * 4. State machine    — explicit states: live | predicting | recovering.
 *                       Transitions are one-way until the next live fix.
 * 5. GPS floor        — route fraction is non-decreasing; the aircraft never moves
 *                       backward on its route.
 * 6. Confidence model — ConfidenceLevel exposed to UI for visual indication.
 *
 * Caller contract
 * ───────────────
 * • Create one FlightPredictor per callsign.
 * • Call setContext() whenever route / schedule data changes (every poll cycle is fine).
 * • Call onLive()        for every fresh ADS-B fix.
 * • Call onStaleFix()    for FR24-cache positions that were captured in the past.
 * • Call onSignalLoss()  once when the callsign drops out of the live feed.
 * • Call getDisplay(now) to get the display position (can be called at any frequency).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type TrackingState   = 'live' | 'predicting' | 'recovering'
export type ConfidenceLevel = 'live' | 'excellent' | 'high' | 'medium' | 'low' | 'very_low'

export interface Waypoint {
  f:   number   // 0.0 = departure, 1.0 = arrival
  lat: number
  lon: number
}

export interface LivePosition {
  lat:         number
  lon:         number
  track_deg:   number   // magnetic/true track, 0–360
  gs_kts:      number   // ground speed, knots
  vs_fpm:      number   // vertical speed, ft/min (positive = climb)
  altitude_ft: number | null
}

export interface FlightContext {
  dep_coords:        [number, number]   // [lat, lon]
  arr_coords:        [number, number]
  actual_dep_utc_ms: number | null      // confirmed departure, ms epoch
  duration_ms:       number | null      // full flight duration in ms
  sched_dep_utc_ms:  number | null      // scheduled departure fallback
  waypoints:         Waypoint[]         // canonical route path (may be empty)
}

export interface DisplayPosition {
  lat:           number
  lon:           number
  track_deg:     number
  altitude_ft:   number | null
  state:         TrackingState
  confidence:    ConfidenceLevel
  isEstimated:   boolean      // true during predicting; false during live or recovering
  signalLostMs:  number | null // ms elapsed since signal loss; null when live
  routeFraction: number        // 0–1.1 estimated flight progress (>1 = post-arrival)
}

export interface PredictorConfig {
  /** Signal gap (ms) below which kinematic weight is 1.0 */
  kinematicFullMs:         number
  /** Signal gap (ms) at which kinematic weight reaches 0.0 */
  kinematicFadeEndMs:      number
  /** Max kinematic deviation from route before weight penalty applies (km) */
  maxKinematicDeviationKm: number
  /** Recovery blend: ms of blend duration per km of prediction error */
  recoveryMsPerKm:         number
  minRecoveryMs:           number
  maxRecoveryMs:           number
  /** Confidence thresholds — ms of signal loss */
  excellentMs: number
  highMs:      number
  mediumMs:    number
  lowMs:       number
  /** When true, route fraction is non-decreasing (no backward movement) */
  routeFractionFloor: boolean
  /** Altitude: maximum ft drift allowed beyond last measured altitude */
  maxAltDriftFt: number
}

export const DEFAULT_CONFIG: Readonly<PredictorConfig> = {
  kinematicFullMs:          2 * 60_000,   //  2 min
  kinematicFadeEndMs:      20 * 60_000,   // 20 min
  maxKinematicDeviationKm: 60,
  recoveryMsPerKm:         20_000,        // 20 s per km
  minRecoveryMs:            4_000,        //  4 s
  maxRecoveryMs:           90_000,        // 90 s
  excellentMs:              2 * 60_000,
  highMs:                  10 * 60_000,
  mediumMs:                20 * 60_000,
  lowMs:                   60 * 60_000,   // GPS jamming in the region can last 1-4 h
  routeFractionFloor:      true,
  maxAltDriftFt:           5_000,
}

// ─────────────────────────────────────────────────────────────────────────────
// Geodesic math  (sphere, WGS-84 mean radius)
// ─────────────────────────────────────────────────────────────────────────────

const DEG   = Math.PI / 180
const R_KM  = 6371.0088

export function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const dLat = (lat2 - lat1) * DEG
  const dLon = (lon2 - lon1) * DEG
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2
  return R_KM * 2 * Math.asin(Math.sqrt(Math.min(1, a)))
}

/**
 * Project a geodesic point: start at (lat, lon), travel bearingDeg for distKm.
 * Uses spherical law of sines — accurate to 0.3 % for distances up to 3 000 km.
 */
export function geodesicProject(
  lat: number, lon: number,
  bearingDeg: number,
  distKm: number,
): [number, number] {
  const δ  = distKm / R_KM
  const θ  = bearingDeg * DEG
  const φ1 = lat * DEG
  const λ1 = lon * DEG
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  )
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
  )
  return [φ2 / DEG, ((λ2 / DEG) + 540) % 360 - 180]
}

/**
 * Spherical linear interpolation (SLERP) between two geodesic points.
 * Returns the point fraction t along the great circle from p1 to p2.
 */
export function slerpGC(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
  t:    number,
): [number, number] {
  const toCart = (φ: number, λ: number): [number, number, number] => {
    const r = φ * DEG, s = λ * DEG
    return [Math.cos(r) * Math.cos(s), Math.cos(r) * Math.sin(s), Math.sin(r)]
  }
  const [x1, y1, z1] = toCart(lat1, lon1)
  const [x2, y2, z2] = toCart(lat2, lon2)
  const dot  = Math.min(1, Math.max(-1, x1 * x2 + y1 * y2 + z1 * z2))
  const ω    = Math.acos(dot)
  if (ω < 1e-9) return [lat1, lon1]
  const sinω = Math.sin(ω)
  const w1   = Math.sin((1 - t) * ω) / sinω
  const w2   = Math.sin(t       * ω) / sinω
  const x = w1 * x1 + w2 * x2
  const y = w1 * y1 + w2 * y2
  const z = w1 * z1 + w2 * z2
  return [
    Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG,
    Math.atan2(y, x) / DEG,
  ]
}

/** Bearing at parametric position t along the great circle from p1 to p2. */
export function gcBearing(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
  t: number,
): number {
  const dt = Math.min(0.005, (1 - t) / 2)
  const [aLat, aLon] = slerpGC(lat1, lon1, lat2, lon2, Math.max(0, t - dt))
  const [bLat, bLon] = slerpGC(lat1, lon1, lat2, lon2, Math.min(1, t + dt))
  const dλ = (bLon - aLon) * DEG
  const y  = Math.sin(dλ) * Math.cos(bLat * DEG)
  const x  = Math.cos(aLat * DEG) * Math.sin(bLat * DEG)
           - Math.sin(aLat * DEG) * Math.cos(bLat * DEG) * Math.cos(dλ)
  return (Math.atan2(y, x) / DEG + 360) % 360
}

// ─────────────────────────────────────────────────────────────────────────────
// Route-path helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interpolate a position on a waypoint list at fraction f.
 * Uses great-circle SLERP within each segment.
 */
export function interpolatePath(wps: Waypoint[], f: number): [number, number] {
  if (!wps.length) return [0, 0]
  if (f <= wps[0].f) return [wps[0].lat, wps[0].lon]
  const last = wps[wps.length - 1]
  if (f >= last.f) return [last.lat, last.lon]

  let lo = 0, hi = wps.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (wps[mid].f <= f) lo = mid; else hi = mid
  }
  const a = wps[lo], b = wps[hi]
  const span = b.f - a.f
  if (span < 1e-9) return [a.lat, a.lon]
  return slerpGC(a.lat, a.lon, b.lat, b.lon, (f - a.f) / span)
}

/** Bearing at fraction f on a waypoint path. */
export function bearingFromPath(wps: Waypoint[], f: number): number {
  const dt = 0.01
  const [aLat, aLon] = interpolatePath(wps, Math.max(0, f - dt / 2))
  const [bLat, bLon] = interpolatePath(wps, Math.min(1, f + dt / 2))
  const dλ = (bLon - aLon) * DEG
  const y  = Math.sin(dλ) * Math.cos(bLat * DEG)
  const x  = Math.cos(aLat * DEG) * Math.sin(bLat * DEG)
           - Math.sin(aLat * DEG) * Math.cos(bLat * DEG) * Math.cos(dλ)
  return (Math.atan2(y, x) / DEG + 360) % 360
}

/** Waypoint fraction on wps that is geometrically closest to (lat, lon). */
export function nearestPathFraction(wps: Waypoint[], lat: number, lon: number): number {
  if (!wps.length) return 0
  let bestF = wps[0].f, bestDist = Infinity
  for (const wp of wps) {
    const d = haversineKm(lat, lon, wp.lat, wp.lon)
    if (d < bestDist) { bestDist = d; bestF = wp.f }
  }
  return bestF
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

/** Smooth cubic Hermite interpolation: 0 at lo, 1 at hi, S-curve in between. */
function smoothstep(x: number, lo: number, hi: number): number {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

/**
 * Kinematic weight as a function of ms since signal loss.
 *
 * Timeline:
 *   0 → kinematicFullMs          : 1.0  (pure kinematic)
 *   kinematicFullMs → FadeEndMs  : 1.0 → 0.0  (smooth fade)
 *   > kinematicFadeEndMs         : 0.0  (pure route)
 */
function kinematicWeight(gapMs: number, cfg: PredictorConfig): number {
  if (gapMs <= cfg.kinematicFullMs)   return 1.0
  if (gapMs >= cfg.kinematicFadeEndMs) return 0.0
  return 1.0 - smoothstep(gapMs, cfg.kinematicFullMs, cfg.kinematicFadeEndMs)
}

/** Circular angle interpolation — avoids wrap-around (e.g., 350° → 10° at t=0.5 → 0°). */
function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((b - a + 540) % 360) - 180  // -180..+180 shortest path
  return (a + diff * t + 360) % 360
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal state types
// ─────────────────────────────────────────────────────────────────────────────

interface KinematicCapture {
  lat:          number
  lon:          number
  track_deg:    number
  gs_kts:       number
  vs_fpm:       number
  altitude_ft:  number | null
  capturedAtMs: number
}

interface RecoveryState {
  startMs:            number
  durationMs:         number
  predictedAtStart:   [number, number]  // frozen predicted position at recovery start
}

/**
 * The mirror of RecoveryState, for a loss noticed late rather than a signal regained.
 *
 * Recovery blends a frozen prediction toward a fixed live position. This blends a frozen live
 * position toward a prediction that is still moving, which is the same problem pointing the other
 * way: in both cases the honest answer is somewhere the marker is not, and teleporting it there
 * reads as a fault even when the new position is the correct one.
 */
interface CatchUpState {
  startMs:      number
  durationMs:   number
  fromLat:      number
  fromLon:      number
}

// ─────────────────────────────────────────────────────────────────────────────
// FlightPredictor
// ─────────────────────────────────────────────────────────────────────────────

export class FlightPredictor {
  private readonly cfg: PredictorConfig

  // Current flight context (route + schedule). Updated externally each poll cycle.
  private ctx:  FlightContext | null = null

  // Last reliable kinematic snapshot from an ADS-B fix.
  private kin:  KinematicCapture | null = null

  // Last live position (for recovery blend target).
  private lastLive: { lat: number; lon: number; track_deg: number; altitude_ft: number | null } | null = null

  // State machine
  private _state:          TrackingState = 'predicting'
  private signalLostAtMs:  number | null = null

  // Recovery blend state
  private recovery: RecoveryState | null = null

  // Catch-up blend state — set when a loss is discovered after the fact.
  private catchUp: CatchUpState | null = null

  // Non-decreasing route fraction floor (GPS lock-in).
  private _minFraction: number = 0

  constructor(cfg: Partial<PredictorConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Update flight context. Safe to call every poll cycle. */
  setContext(ctx: FlightContext): void {
    this.ctx = ctx
  }

  /**
   * Record a fresh ADS-B fix (signal is live right now).
   * @param pos   Current aircraft state
   * @param nowMs Current wall-clock time (ms epoch)
   */
  onLive(pos: LivePosition, nowMs: number): void {
    this._absorbFix(pos, nowMs, nowMs)
  }

  /**
   * Record a stale position (e.g., FR24 cache).
   * The position was valid at capturedAtMs, not at nowMs.
   * The predictor enters 'predicting' immediately with signalLostAtMs = capturedAtMs.
   *
   * @param pos           Aircraft state at capture time
   * @param capturedAtMs  When the position was actually captured (ms epoch)
   * @param nowMs         Current wall-clock time (ms epoch)
   */
  onStaleFix(pos: LivePosition, capturedAtMs: number, nowMs: number): void {
    this._absorbFix(pos, capturedAtMs, nowMs)
    // Signal is already in the past — enter predicting if not already
    if (this._state === 'live') {
      this._state         = 'predicting'
      this.signalLostAtMs = capturedAtMs
      this.recovery       = null
    }
  }

  /**
   * Notify the predictor that the signal was lost at nowMs.
   * Idempotent — safe to call multiple times.
   */
  onSignalLoss(nowMs: number): void {
    if (this._state !== 'predicting') {
      this._state         = 'predicting'
      this.signalLostAtMs ??= nowMs
      this.recovery       = null
    } else {
      this.signalLostAtMs ??= nowMs
    }
  }

  /**
   * The signal stopped arriving at lostAtMs, and we are only finding out at nowMs.
   *
   * onSignalLoss assumes the loss is happening as it is reported, so prediction starts from zero
   * elapsed and the marker creeps away from its last drawn position. When the loss is discovered
   * late that assumption breaks: the prediction is immediately (nowMs − lostAtMs) of travel ahead
   * of where the marker is drawn, and applying it in one step throws the aircraft down its route.
   * Measured 15 Aug 2026 on FYC762 — 150 s of undiscovered loss at 369 kt is about 15 km, and it
   * arrived in a single frame.
   *
   * The prediction is not wrong; the aircraft really is that far along. What is wrong is showing
   * the correction all at once, so it is eased in — from where the marker actually is, toward a
   * target that keeps moving, over the same per-kilometre schedule the recovery blend uses. The
   * error is the distance between the two, so a small discovery costs a short blend and a large
   * one is spread over as much as maxRecoveryMs.
   *
   * Idempotent in the way that matters: once predicting, later calls only fill in a missing loss
   * time. A flight sitting stale across many polls blends once, not on every poll.
   */
  onSignalLostAt(lostAtMs: number, nowMs: number): void {
    if (this._state === 'predicting') {
      this.signalLostAtMs ??= lostAtMs
      return
    }
    const from = this.lastLive
    this._state         = 'predicting'
    this.signalLostAtMs = lostAtMs
    this.recovery       = null

    // Nothing has been drawn yet, so there is no position to ease away from.
    if (!from) { this.catchUp = null; return }

    const pred    = this._computePredicted(nowMs)
    const errorKm = haversineKm(from.lat, from.lon, pred.lat, pred.lon)
    this.catchUp  = {
      startMs:    nowMs,
      durationMs: Math.min(
        this.cfg.maxRecoveryMs,
        Math.max(this.cfg.minRecoveryMs, errorKm * this.cfg.recoveryMsPerKm),
      ),
      fromLat: from.lat,
      fromLon: from.lon,
    }
  }

  get state(): TrackingState { return this._state }

  /** Confidence level based on elapsed signal loss duration. */
  confidence(nowMs: number): ConfidenceLevel {
    if (this._state !== 'predicting') return 'live'
    const gap = this.signalLostAtMs ? nowMs - this.signalLostAtMs : 0
    if (gap < this.cfg.excellentMs) return 'excellent'
    if (gap < this.cfg.highMs)      return 'high'
    if (gap < this.cfg.mediumMs)    return 'medium'
    if (gap < this.cfg.lowMs)       return 'low'
    return 'very_low'
  }

  /**
   * Compute the display position for the current time.
   * Thread-safe (read-only during predicting/recovering; mutates on recovery completion).
   * O(n_waypoints) where n is typically 13.
   */
  getDisplay(nowMs: number): DisplayPosition {
    const routeFraction = Math.min(1.1, Math.max(0, this._routeFraction(nowMs) ?? this._minFraction))
    const signalLostMs  = this._state === 'predicting' && this.signalLostAtMs
      ? nowMs - this.signalLostAtMs
      : null

    // ── Live ──────────────────────────────────────────────────────────────────
    if (this._state === 'live') {
      const lp = this.lastLive!
      return {
        lat: lp.lat, lon: lp.lon, track_deg: lp.track_deg, altitude_ft: lp.altitude_ft,
        state: 'live', confidence: 'live', isEstimated: false,
        signalLostMs: null, routeFraction,
      }
    }

    // ── Predicted position (shared by recovering and predicting) ──────────────
    const pred = this._computePredicted(nowMs)

    // ── Recovering ────────────────────────────────────────────────────────────
    if (this._state === 'recovering' && this.recovery) {
      const { startMs, durationMs, predictedAtStart } = this.recovery
      const rawT = (nowMs - startMs) / durationMs
      const t    = smoothstep(rawT, 0, 1)

      if (rawT >= 1.0) {
        // Convergence complete — transition back to live
        this._state   = 'live'
        this.recovery = null
        const lp = this.lastLive!
        return {
          lat: lp.lat, lon: lp.lon, track_deg: lp.track_deg, altitude_ft: lp.altitude_ft,
          state: 'live', confidence: 'live', isEstimated: false,
          signalLostMs: null, routeFraction,
        }
      }

      // Blend: frozen predicted snapshot → current live position
      const lp  = this.lastLive!
      const lat = predictedAtStart[0] + t * (lp.lat  - predictedAtStart[0])
      const lon = predictedAtStart[1] + t * (lp.lon  - predictedAtStart[1])
      const trk = lerpAngle(pred.track_deg, lp.track_deg, t)
      return {
        lat, lon, track_deg: trk, altitude_ft: lp.altitude_ft,
        state: 'recovering', confidence: 'live', isEstimated: false,
        signalLostMs: null, routeFraction,
      }
    }

    // ── Predicting ────────────────────────────────────────────────────────────
    /*
     * Easing in a loss we noticed late. The target moves while the blend runs — that is the
     * difference from recovery above, where the target is a fixed fix — so the marker keeps
     * advancing throughout and never stalls or backs up waiting for the blend to finish.
     */
    if (this.catchUp) {
      const rawT = (nowMs - this.catchUp.startMs) / this.catchUp.durationMs
      if (rawT >= 1.0) {
        this.catchUp = null
      } else {
        const t   = smoothstep(rawT, 0, 1)
        const lat = this.catchUp.fromLat + t * (pred.lat - this.catchUp.fromLat)
        const lon = this.catchUp.fromLon + t * (pred.lon - this.catchUp.fromLon)
        return {
          lat, lon,
          track_deg: pred.track_deg, altitude_ft: pred.altitude_ft,
          state: 'predicting', confidence: this.confidence(nowMs), isEstimated: true,
          signalLostMs, routeFraction,
        }
      }
    }

    return {
      lat: pred.lat, lon: pred.lon,
      track_deg: pred.track_deg, altitude_ft: pred.altitude_ft,
      state: 'predicting', confidence: this.confidence(nowMs), isEstimated: true,
      signalLostMs, routeFraction,
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Absorb a fix, update kinematic state, and manage state transitions. */
  private _absorbFix(pos: LivePosition, capturedAtMs: number, nowMs: number): void {
    if (pos.gs_kts > 50) {
      this.kin = {
        lat: pos.lat, lon: pos.lon,
        track_deg: pos.track_deg, gs_kts: pos.gs_kts,
        vs_fpm: pos.vs_fpm, altitude_ft: pos.altitude_ft,
        capturedAtMs,
      }
      if (this.ctx?.waypoints.length) {
        const f = nearestPathFraction(this.ctx.waypoints, pos.lat, pos.lon)
        if (this.cfg.routeFractionFloor) {
          this._minFraction = Math.max(this._minFraction, f)
        } else {
          this._minFraction = f
        }
      }
    }

    const wasLost = this._state === 'predicting'

    if (wasLost && this.lastLive !== null) {
      // Signal returned — start recovery blend
      const predicted   = this._computePredicted(nowMs)
      const errorKm     = haversineKm(predicted.lat, predicted.lon, pos.lat, pos.lon)
      const durationMs  = Math.min(
        this.cfg.maxRecoveryMs,
        Math.max(this.cfg.minRecoveryMs, errorKm * this.cfg.recoveryMsPerKm),
      )
      this._state   = 'recovering'
      this.recovery = {
        startMs:          nowMs,
        durationMs,
        predictedAtStart: [predicted.lat, predicted.lon],
      }
    } else {
      this._state   = 'live'
      this.recovery = null
    }

    this.lastLive       = { lat: pos.lat, lon: pos.lon, track_deg: pos.track_deg, altitude_ft: pos.altitude_ft }
    this.signalLostAtMs = null
    // A real fix outranks any catch-up still running: recovery takes over from here, blending to
    // the position we were just given rather than to one we were guessing at.
    this.catchUp        = null
  }

  /**
   * Compute the hybrid predicted position.
   *
   * Weights by elapsed gap:
   *   0–2 min    : 100 % kinematic DR
   *   2–20 min   : smooth fade from kinematic → route
   *   20+ min    : 100 % route-following
   *
   * If kinematic deviates far from the route, its weight is penalised further.
   */
  private _computePredicted(nowMs: number): {
    lat: number; lon: number; track_deg: number; altitude_ft: number | null
  } {
    const gapMs  = this.signalLostAtMs ? nowMs - this.signalLostAtMs : 0
    const wKin   = kinematicWeight(gapMs, this.cfg)
    const wRoute = 1 - wKin
    const ctx    = this.ctx

    // ── Kinematic component ──────────────────────────────────────────────────
    let kinLat = 0, kinLon = 0, kinTrack = 0, kinAlt: number | null = null
    let hasKin = false

    if (this.kin) {
      const sinceMs = nowMs - this.kin.capturedAtMs
      const distKm  = this.kin.gs_kts * 1.852 * (sinceMs / 3_600_000)
      ;[kinLat, kinLon] = geodesicProject(this.kin.lat, this.kin.lon, this.kin.track_deg, distKm)
      kinTrack = this.kin.track_deg
      if (this.kin.altitude_ft !== null) {
        const driftFt = this.kin.vs_fpm * (sinceMs / 60_000)
        kinAlt = this.kin.altitude_ft + Math.max(-this.cfg.maxAltDriftFt, Math.min(this.cfg.maxAltDriftFt, driftFt))
      }
      hasKin = true
    }

    // ── Route component ──────────────────────────────────────────────────────
    let routeLat = 0, routeLon = 0, routeTrack = 0
    let hasRoute = false
    const routeF = this._routeFraction(nowMs)

    if (ctx && routeF !== null) {
      const f = Math.max(this._minFraction, Math.min(0.99, routeF))
      if (ctx.waypoints.length) {
        ;[routeLat, routeLon] = interpolatePath(ctx.waypoints, f)
        routeTrack            = bearingFromPath(ctx.waypoints, f)
      } else {
        const [dLat, dLon] = ctx.dep_coords
        const [aLat, aLon] = ctx.arr_coords
        ;[routeLat, routeLon] = slerpGC(dLat, dLon, aLat, aLon, f)
        routeTrack            = gcBearing(dLat, dLon, aLat, aLon, f)
      }
      hasRoute = true
    }

    // ── Nothing to work with ─────────────────────────────────────────────────
    if (!hasKin && !hasRoute) {
      const lp = this.lastLive
      return { lat: lp?.lat ?? 0, lon: lp?.lon ?? 0, track_deg: lp?.track_deg ?? 0, altitude_ft: lp?.altitude_ft ?? null }
    }

    // ── Near destination: kill kinematic to prevent overshoot past arrival ───
    // Kinematic DR has no awareness of the destination — it projects heading
    // forward indefinitely. Within the last 10 % of the route, fade it out
    // linearly so the plane is guaranteed to stop at the arrival airport.
    const nearDestPenalty = (routeF !== null && routeF >= 0.90)
      ? Math.max(0, 1 - (routeF - 0.90) / 0.10)   // 1.0 at f=0.90 → 0.0 at f=1.0
      : 1
    const wKinAdj = wKin * nearDestPenalty

    // No kinematic data — must use route regardless of weight
    if (!hasKin) return { lat: routeLat, lon: routeLon, track_deg: routeTrack, altitude_ft: kinAlt }
    if (!hasRoute || wKinAdj >= 1.0) {
      // Even at full kinematic weight (first 2 min), sanity-check the heading against
      // the route to catch GPS-spoofed/jammed tracks before returning them raw.
      const safeTrack = hasRoute
        ? (Math.abs(((kinTrack - routeTrack) + 540) % 360 - 180) > 90 ? routeTrack : kinTrack)
        : kinTrack
      return { lat: kinLat, lon: kinLon, track_deg: safeTrack, altitude_ft: kinAlt }
    }
    if (wKinAdj <= 0.0) return { lat: routeLat, lon: routeLon, track_deg: routeTrack, altitude_ft: kinAlt }

    // ── Penalise kinematic weight when it has drifted far from the route ─────
    const kinDevKm = haversineKm(kinLat, kinLon, routeLat, routeLon)
    const penalty  = kinDevKm > this.cfg.maxKinematicDeviationKm
      ? Math.max(0, 1 - (kinDevKm - this.cfg.maxKinematicDeviationKm) / 150)
      : 1
    const effWKin   = wKinAdj * penalty
    const effWRoute = 1 - effWKin

    // Linear lat/lon blend is accurate within 0.01° for flights up to 10 000 km.
    const blendLat  = kinLat * effWKin + routeLat * effWRoute
    const blendLon  = kinLon * effWKin + routeLon * effWRoute
    // Track sanity: if kinematic heading contradicts the route direction by >90°
    // it is almost certainly corrupted (GPS spoofing/jamming). Fall back to the
    // route bearing so the icon at least points the right way.
    const trackDiff  = Math.abs(((kinTrack - routeTrack) + 540) % 360 - 180)
    const blendTrack = trackDiff > 90
      ? routeTrack
      : lerpAngle(routeTrack, kinTrack, effWKin)

    return { lat: blendLat, lon: blendLon, track_deg: blendTrack, altitude_ft: kinAlt }
  }

  /**
   * Compute the normalised route fraction (0 = dep, 1 = arr) for nowMs.
   *
   * Priority:
   *   1. actual_dep_utc_ms + duration_ms  (most accurate)
   *   2. sched_dep_utc_ms fallback
   *   3. GPS-anchored fraction from last kinematic fix
   */
  private _routeFraction(nowMs: number): number | null {
    const ctx = this.ctx
    if (!ctx) return null

    if (ctx.actual_dep_utc_ms !== null && ctx.duration_ms !== null && ctx.duration_ms > 0) {
      const f = (nowMs - ctx.actual_dep_utc_ms) / ctx.duration_ms
      if (f >= 0) return f
    }

    if (ctx.sched_dep_utc_ms !== null && ctx.duration_ms !== null && ctx.duration_ms > 0) {
      const elapsed = nowMs - ctx.sched_dep_utc_ms
      if (elapsed >= 0 && elapsed <= ctx.duration_ms * 2) {
        return elapsed / ctx.duration_ms
      }
    }

    // GPS-anchored: use nearest waypoint to last known position
    if (this.kin && ctx.waypoints.length) {
      return nearestPathFraction(ctx.waypoints, this.kin.lat, this.kin.lon)
    }

    return null
  }
}

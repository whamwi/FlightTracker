/**
 * Where a flight actually is along its route, when all we have is a departure time.
 *
 * The map draws a "ghost" for a flight FR24 has reported airborne but no receiver has yet placed —
 * routine out of Aleppo, which has no low-altitude coverage, so the first fix arrives only once the
 * aircraft is high enough to be seen. Until then the position is a projection.
 *
 * That projection was linear: elapsed over block, straight down the route. Aircraft do not fly
 * linearly from wheels-up, they climb. Measured over ~2,700 fixes across three days of departures,
 * against what the straight line predicted:
 *
 *      1 min    6.8 km flown    11.0 km projected    0.62
 *      2 min   12.7 km           21.9 km             0.58
 *      3 min   15.5 km           32.8 km             0.48
 *      5 min   28.5 km           54.7 km             0.53
 *      8 min   51.5 km           87.3 km             0.60
 *     10 min   73.6 km          108.9 km             0.69
 *     12 min   95.7 km          127.6 km             0.77
 *
 * For the first five minutes the ghost runs about twice as far as the aircraft, and it is still
 * 30% ahead at twelve. RJ434 on 13 and 14 Aug is the case that surfaced it: the departure reached
 * us before the first fix did, the ghost appeared well south of Aleppo, and the fix then snapped
 * the marker back toward the field.
 *
 * The floor is deliberately below the measured minimum, so the ghost sits at or behind the
 * aircraft at every point on the curve above rather than near the mean. That is the direction to
 * err — a marker that lags and then catches up reads as the aircraft overtaking it, while one that
 * runs ahead and jumps back reads as a fault, which is what was reported.
 *
 * Ramps to 1.0 by twenty minutes, so nothing is damped beyond the climb and the projection has no
 * standing lag. Only the pure time-based case uses this: where a predictor or a real fix is driving
 * the marker, the position comes from something observed and needs no model.
 */

/** Fraction of the linear projection to trust while the aircraft is still climbing. */
export const CLIMB_FLOOR = 0.45
/** Minutes the floor holds flat before it starts ramping back toward 1.0. */
export const CLIMB_FLAT_MIN = 8
/** Minutes after which the projection is trusted in full. */
export const CLIMB_FULL_MIN = 20

/** The damping applied to a linear projection at a given time since wheels-up. */
export function climbRamp(elapsedMs: number): number {
  const min = elapsedMs / 60_000
  if (min <= CLIMB_FLAT_MIN) return CLIMB_FLOOR
  const span = CLIMB_FULL_MIN - CLIMB_FLAT_MIN
  return Math.min(1, CLIMB_FLOOR + (1 - CLIMB_FLOOR) * ((min - CLIMB_FLAT_MIN) / span))
}

/** Along-route progress as a fraction, damped for the climb. Zero block means no answer. */
export function climbAdjustedFraction(elapsedMs: number, blockMs: number): number {
  if (blockMs <= 0) return 0
  return (elapsedMs / blockMs) * climbRamp(elapsedMs)
}

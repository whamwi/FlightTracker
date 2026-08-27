/**
 * Where an aircraft is along its corridor, and where it will be a moment from now.
 *
 * The arithmetic V3 animates on, with no imports, no clock and no React — so it can be tested,
 * which is the half of the last rewrite that could only be judged by looking at a phone.
 *
 * ── Why this is rendering and not prediction ────────────────────────────────────────────────
 *
 * V2 draws only where the server said and moves only when the server speaks. That was the right
 * answer while the client had opinions of its own to give up, and it is why the map stopped
 * disagreeing with the board. Interpolating between two arbitrary points would put the marker
 * somewhere nothing asserted, which is the thing that rule exists to prevent.
 *
 * This is not that. The server publishes the corridor the aircraft is on and the rate it must
 * travel to arrive at its ETA — `path` and `motion.fraction_per_sec` on /v2/live. Advancing along
 * a curve the server supplied, at a speed the server computed, toward an instant the server
 * chose, invents nothing. The client is drawing the server's answer between the moments it
 * speaks, not forming one of its own.
 *
 * The test is: could the marker ever be somewhere the server would not put it? Ask the server at
 * any instant and it computes the same fraction from the same rate. So no.
 */

/** A corridor waypoint as /v2/live publishes it: progress along the route, and where that is. */
export type Waypoint = { f: number; lat: number; lon: number }

export type Motion = {
  fraction: number
  fraction_per_sec: number
  arrives_utc: string | null
}

/**
 * How long a correction takes to substantially close: the gap falls to about 5% in this time.
 *
 * Sixty seconds, chosen to match how often a fix actually arrives. Measured 26 Aug across 15
 * observed flights: most update roughly every 55 seconds, not every poll — four polls returning
 * the same fraction, then a jump of about 1% of the route. So a correction spread over a minute
 * is absorbed almost exactly as the next one arrives.
 *
 * It is a rate adjustment, never a teleport. The marker keeps flying; it simply flies a little
 * faster or slower until it agrees with the server again.
 *
 * EXPONENTIAL, not linear, and the difference bit me. A step of gap/60 per second sounds like it
 * closes in sixty seconds and does not: the gap shrinks as it goes, so after a minute 36% still
 * remains. Worse, repeated small steps and one large step give different answers, which makes the
 * catch-up speed depend on the frame rate — the same class of bug as the strip's drift.
 *
 * exp(-dt/tau) has neither problem. It is exact for any dt, and three time constants is the
 * conventional "arrived", so tau is a third of the time we want it to take.
 */
export const CATCH_UP_SEC = 60
const TAU = CATCH_UP_SEC / 3

/**
 * Past this much error, easing is worse than placing.
 *
 * A quarter of a route closed over a minute is not a correction, it is a rocket. An error that
 * large means the marker is not slightly stale but describing a different flight — a
 * re-identification, a diversion, a reappearance after a long silence — and pretending otherwise
 * would draw an aeroplane crossing a country in seconds.
 */
export const MAX_EASE_FRACTION = 0.25

/**
 * How far along the route to draw, `elapsed` seconds after the server said `fraction`.
 *
 * Clamped at 1. A marker that ran past the end would be drawn beyond its destination — and since
 * the rate is computed to reach exactly 1.0 at the ETA, anything past it means the flight is late
 * and the server has not caught up yet. Sitting on the airport is the honest way to be wrong
 * there; sailing past it is not.
 *
 * Never runs backwards either. A revised ETA that moves EARLIER raises the rate rather than
 * rewinding the marker, because the fraction only ever comes from the server.
 */
export function advance(motion: Motion | null | undefined, elapsedSec: number): number | null {
  if (!motion || typeof motion.fraction !== 'number') return null
  const rate = typeof motion.fraction_per_sec === 'number' ? motion.fraction_per_sec : 0
  const moved = motion.fraction + rate * Math.max(0, elapsedSec)
  return Math.min(1, Math.max(0, moved))
}

/**
 * Where to draw now, easing toward what the server last said rather than snapping to it.
 *
 * `shown` is where the marker currently is; `target` is where the server says it should be, from
 * advance(). The gap between them is closed over CATCH_UP_SEC by adjusting speed, so the reader
 * sees an aeroplane flying slightly fast or slow rather than one that jumped.
 *
 * NEVER BACKWARDS, and that is the rule that shapes the rest. When the marker is ahead of the
 * server it slows to a stop and waits to be overtaken; it does not reverse. An aeroplane that
 * flies backwards is obviously broken in a way that one briefly stationary is not — and since
 * `target` only ever advances, waiting is always the shorter path back to agreement.
 *
 * `dt` is the time since this function last ran, not since the poll. Pacing by elapsed time is
 * what keeps a 1 Hz client and a 60 Hz one in the same place, and what stops a 120 Hz screen
 * running at double speed.
 */
export function ease(shown: number | null, target: number, dt: number): number {
  // Nothing to ease from: first sighting, so place it.
  if (shown === null || !Number.isFinite(shown)) return target

  const gap = target - shown
  // Too far to be a correction — this is a different flight, or one back after a long silence.
  if (Math.abs(gap) > MAX_EASE_FRACTION) return target
  // Close enough to call it caught up, and stops an asymptote that never quite lands.
  if (Math.abs(gap) < 1e-6) return target

  // Ahead: hold. Slowing to a stop is invisible; reversing is not, and the target only ever
  // advances, so waiting is the shorter path back to agreement.
  if (gap < 0) return shown

  // Behind: close the gap by exp(-dt/tau). Frame-rate independent by construction — four
  // one-second steps and one four-second step give the same answer, because exp adds in the
  // exponent.
  const remaining = gap * Math.exp(-Math.max(0, dt) / TAU)
  return Math.min(target, target - remaining)
}

/**
 * The point on a corridor at a given progress, and the heading there.
 *
 * Linear between the two waypoints that bracket the fraction. The corridors carry up to 40 points
 * over a route, so a segment is tens of kilometres and a straight line across one is well inside
 * the error of everything else here.
 *
 * A GAP is bridged rather than treated as an end: consensus_path omits bins no two flights
 * crossed, so a corridor legitimately jumps from 0.3 to 0.5 where coverage failed. Interpolating
 * across that is the right answer — the aeroplane certainly flew through it, we simply did not
 * see it — and refusing to would strand the marker at the edge of every hole.
 */
export function pointAt(path: Waypoint[] | null | undefined, fraction: number):
  { lat: number; lon: number; track: number } | null {
  if (!path || path.length === 0) return null
  const f = Math.min(1, Math.max(0, fraction))

  // Before the first waypoint or after the last, the ends are the answer. A corridor that starts
  // at 0.05 because nothing was seen on the climb-out should not extrapolate backwards onto a
  // runway it knows nothing about.
  if (f <= path[0].f) return { ...at(path[0]), track: bearing(path[0], path[1] ?? path[0]) }
  const last = path[path.length - 1]
  if (f >= last.f) return { ...at(last), track: bearing(path[path.length - 2] ?? last, last) }

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1]
    if (f >= a.f && f <= b.f) {
      const span = b.f - a.f
      const t = span > 0 ? (f - a.f) / span : 0
      return {
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
        track: bearing(a, b),
      }
    }
  }
  return { ...at(last), track: bearing(path[path.length - 2] ?? last, last) }
}

const at = (w: Waypoint) => ({ lat: w.lat, lon: w.lon })

/** Initial great-circle bearing between two waypoints, for pointing the icon. */
function bearing(a: Waypoint, b: Waypoint): number {
  const r = Math.PI / 180
  const dLon = (b.lon - a.lon) * r
  const y = Math.sin(dLon) * Math.cos(b.lat * r)
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r)
          - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos(dLon)
  return (Math.atan2(y, x) / r + 360) % 360
}

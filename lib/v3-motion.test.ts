import test from 'node:test'
import assert from 'node:assert/strict'

import { advance, ease, pointAt, type Waypoint } from './v3-motion.ts'

/** A corridor from (30,40) to (34,44), evenly spaced. */
const PATH: Waypoint[] = Array.from({ length: 5 }, (_, i) => ({
  f: i / 4, lat: 30 + i, lon: 40 + i,
}))

test('the marker reaches the end exactly as the rate says it should', () => {
  // The property the whole design rests on: advancing at fraction_per_sec for the remaining
  // time lands on 1.0, so the aeroplane arrives as the countdown beside it reaches zero.
  const m = { fraction: 0.4, fraction_per_sec: 0.6 / 1800, arrives_utc: null }
  assert.equal(advance(m, 1800), 1)
})

test('it never runs past the end', () => {
  // Past the ETA the flight is late and the server has not caught up. Sitting on the airport is
  // the honest way to be wrong; sailing beyond it is not.
  const m = { fraction: 0.9, fraction_per_sec: 0.001, arrives_utc: null }
  assert.equal(advance(m, 10_000), 1)
})

test('it never runs backwards', () => {
  const m = { fraction: 0.5, fraction_per_sec: 0.001, arrives_utc: null }
  assert.ok(advance(m, 0)! >= 0.5)
  assert.equal(advance(m, -50), 0.5, 'a clock that jumped backwards must not rewind the marker')
})

test('a flight with no motion is not animated', () => {
  // The server withholds motion when there is nothing to count toward — no ETA, or one already
  // past. Inventing movement there is exactly what V2 exists to prevent.
  assert.equal(advance(null, 60), null)
  assert.equal(advance(undefined, 60), null)
  assert.equal(advance({ fraction: undefined as any, fraction_per_sec: 1, arrives_utc: null }, 60), null)
})

test('a stationary rate holds position', () => {
  const m = { fraction: 1, fraction_per_sec: 0, arrives_utc: null }
  assert.equal(advance(m, 3600), 1, 'an arrived flight sits still rather than creeping')
})

test('a point mid-corridor is between the two waypoints that bracket it', () => {
  const p = pointAt(PATH, 0.375)!          // halfway between f=0.25 and f=0.5
  assert.ok(Math.abs(p.lat - 31.5) < 1e-9)
  assert.ok(Math.abs(p.lon - 41.5) < 1e-9)
})

test('the ends are the ends, not an extrapolation', () => {
  /*
   * A corridor that starts at 0.05 because nothing was seen on the climb-out must not run
   * backwards onto a runway it knows nothing about.
   */
  const late: Waypoint[] = [{ f: 0.2, lat: 31, lon: 41 }, { f: 0.9, lat: 33, lon: 43 }]
  assert.deepEqual(pointAt(late, 0)!.lat, 31)
  assert.deepEqual(pointAt(late, 1)!.lat, 33)
})

test('a gap in the corridor is bridged, not treated as the end', () => {
  /*
   * consensus_path omits bins no two flights crossed, so a corridor legitimately jumps where
   * coverage failed. The aeroplane certainly flew through it; refusing to interpolate would
   * strand the marker at the edge of every hole.
   */
  const gapped: Waypoint[] = [
    { f: 0.0, lat: 30, lon: 40 },
    { f: 0.3, lat: 31, lon: 41 },
    { f: 0.7, lat: 33, lon: 43 },   // nothing between 0.3 and 0.7
    { f: 1.0, lat: 34, lon: 44 },
  ]
  const mid = pointAt(gapped, 0.5)!
  assert.ok(mid.lat > 31 && mid.lat < 33, `bridged, got ${mid.lat}`)
})

test('the heading follows the corridor rather than the endpoints', () => {
  // A dogleg: north first, then east. At the turn the icon must point the way the leg goes.
  const dogleg: Waypoint[] = [
    { f: 0, lat: 30, lon: 40 },
    { f: 0.5, lat: 34, lon: 40 },   // due north
    { f: 1, lat: 34, lon: 46 },     // due east
  ]
  assert.ok(Math.abs(pointAt(dogleg, 0.25)!.track - 0) < 1, 'north on the first leg')

  /*
   * 88.3, not 90 — and that is correct rather than a rounding slip.
   *
   * This is the INITIAL great-circle bearing, and a great circle between two points at the same
   * latitude bows toward the pole, so it sets off slightly north of east and comes back. Only a
   * rhumb line would read exactly 90. The first version of this test asserted within one degree
   * and failed on real spherical geometry.
   *
   * It matters for more than the test: over a long leg the icon's heading and the straight line
   * on screen genuinely differ, and the heading is the one telling the truth.
   */
  const east = pointAt(dogleg, 0.75)!.track
  assert.ok(east > 85 && east < 90, `east-ish on the second leg, got ${east.toFixed(2)}`)
})


test('no path means no position', () => {
  assert.equal(pointAt(null, 0.5), null)
  assert.equal(pointAt([], 0.5), null)
})

// ── Easing: the fix corrects the rate, never the position ────────────────────

test('a marker behind the server catches up over a minute, not instantly', () => {
  const shown = 0.50, target = 0.52
  const after1s = ease(shown, target, 1)
  assert.ok(after1s > shown && after1s < target, 'moved, but nowhere near arrived')
  /*
   * Sixty seconds closes it to about 5%, not to zero — exponential decay approaches rather than
   * arrives, and CATCH_UP_SEC is three time constants. The first version of this asserted it
   * landed exactly and failed at 36% remaining, because a gap/60 step is not a 60-second close.
   */
  let f = shown
  for (let i = 0; i < 60; i++) f = ease(f, target, 1)
  const left = (target - f) / (target - shown)
  assert.ok(left < 0.06, `about 5% left after a minute, got ${(left * 100).toFixed(1)}%`)
})

test('a marker ahead of the server waits rather than reversing', () => {
  /*
   * The rule that shapes the rest. An aeroplane flying backwards is obviously broken in a way
   * that one briefly stationary is not — and since the target only ever advances, waiting is
   * always the shorter path back to agreement.
   */
  const shown = 0.60
  assert.equal(ease(shown, 0.58, 1), shown, 'held, not rewound')
  assert.equal(ease(shown, 0.58, 30), shown, 'still held after thirty seconds')
})

test('it never overshoots the target', () => {
  // A long frame must not fling the marker past where the server says it is.
  assert.equal(ease(0.5, 0.52, 10_000), 0.52)
})

test('a first sighting is placed, not eased', () => {
  assert.equal(ease(null, 0.4, 1), 0.4, 'nothing to ease from')
})

test('an enormous gap is placed, because easing it would be a rocket', () => {
  /*
   * A quarter of a route closed over a minute is not a correction. An error that large means a
   * different flight — a re-identification, a diversion, a return after long silence — and
   * easing would draw an aeroplane crossing a country in seconds.
   */
  assert.equal(ease(0.1, 0.9, 1), 0.9)
  assert.equal(ease(0.9, 0.1, 1), 0.1, 'and backwards too, when it is that far out')
})

test('easing is paced by elapsed time, not by how often it runs', () => {
  // One 4-second step and four 1-second steps must land in the same place, or the marker moves
  // at a speed that depends on the frame rate.
  const once = ease(0.5, 0.6, 4)
  let many = 0.5
  for (let i = 0; i < 4; i++) many = ease(many, 0.6, 1)
  assert.ok(Math.abs(once - many) < 1e-4, `${once} vs ${many}`)
})

// ── Motion and correction are different things ───────────────────────────────

test('a marker in sync advances at the aircraft\'s own rate, not a fraction of it', () => {
  /*
   * The artefact this fixes. Feeding a continuously advancing target into the filter damped the
   * aeroplane's own speed along with the correction, so a newly drawn marker crawled: measured on
   * the web 27 Aug, SYR444 was at 7% of its true rate thirty seconds after appearing.
   */
  const rate = 1e-4                       // ~2.8 hours end to end
  let shown = 0.5
  let target = 0.5
  for (let i = 0; i < 30; i++) {
    target += rate                        // the server advances too
    shown = ease(shown, target, 1, rate)
  }
  const travelled = shown - 0.5
  const expected = rate * 30
  assert.ok(travelled > expected * 0.99,
    `should keep pace: travelled ${travelled.toExponential(3)} vs ${expected.toExponential(3)}`)
})

test('it still closes a real correction, on top of the motion', () => {
  const rate = 1e-4
  // Half a percent behind, which is a correction rather than a different flight.
  let shown = 0.50
  let target = 0.505
  for (let i = 0; i < 60; i++) { target += rate; shown = ease(shown, target, 1, rate) }
  const left = target - shown
  assert.ok(left < 0.0005, `the 0.005 error should be mostly gone, ${left.toExponential(2)} left`)
})

test('a marker ahead slows rather than stopping dead', () => {
  /*
   * The old rule held it completely still whenever it was ahead. Slowing is invisible; stopping
   * is not, and an aeroplane frozen mid-air reads as broken.
   */
  const rate = 1e-4
  const shown = 0.60
  const next = ease(shown, 0.5995, 1, rate)   // server slightly behind the marker
  assert.ok(next >= shown, 'never reverses')
  assert.ok(next - shown < rate, 'but moves slower than full rate while it gives the server time')
})

test('it never runs past the end of the route', () => {
  assert.equal(ease(0.9999, 1, 1, 0.01), 1)
})

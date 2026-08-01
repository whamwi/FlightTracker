/**
 * Unit tests for PathTracker.
 *
 * Run with:  node --experimental-strip-types --test lib/path-tracker.test.ts
 * (Node 22+)  or:  npx tsx --test lib/path-tracker.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  PathTracker,
  DEFAULT_PATH_CONFIG,
  type PathContext,
} from './path-tracker.ts'
import { interpolatePath, haversineKm, type Waypoint } from './flight-predictor.ts'

// A straight west→east path along the equator-ish, easy to reason about.
const PATH: Waypoint[] = [
  { f: 0.00, lat: 33.0, lon: 36.0 },
  { f: 0.25, lat: 33.0, lon: 40.0 },
  { f: 0.50, lat: 33.0, lon: 44.0 },
  { f: 0.75, lat: 33.0, lon: 48.0 },
  { f: 1.00, lat: 33.0, lon: 52.0 },
]

const T0   = 1_700_000_000_000
const HOUR = 3_600_000

function ctx(over: Partial<PathContext> = {}): PathContext {
  return {
    waypoints:      PATH,
    dep_coords:     [33.0, 36.0],
    arr_coords:     [33.0, 52.0],
    departed_at_ms: T0,
    eta_ms:         T0 + 4 * HOUR,
    duration_ms:    4 * HOUR,
    ...over,
  }
}

/**
 * Position exactly on the route at fraction f.
 *
 * Uses the library's own interpolation rather than assuming a straight line in lat/lon:
 * the path is interpolated along great circles, which bow away from a constant-latitude
 * line by enough to trip the off-path rejection.
 */
function onPath(f: number): { lat: number; lon: number } {
  const [lat, lon] = interpolatePath(PATH, f)
  return { lat, lon }
}

describe('progress is monotonic', () => {
  test('never reverses even when fixes insist the aircraft is behind', () => {
    const t = new PathTracker(ctx(), T0)
    let prev = -1

    for (let i = 1; i <= 40; i++) {
      const now = T0 + i * 5 * 60_000
      // Every fix claims the aircraft is far behind where we think it is.
      t.applyFix({ ...onPath(0.01), at_ms: now }, now)
      const s = t.position(now).routeFraction
      assert.ok(s >= prev, `s went backwards at step ${i}: ${s} < ${prev}`)
      prev = s
    }
  })

  // The route is ~1490 km over 4 h, so backward steps must stay small enough to be
  // physically reachable — otherwise the impossible-speed guard fires first and the
  // backward logic never gets exercised.
  test('a single spurious backward fix is not believed', () => {
    const t = new PathTracker(ctx(), T0)
    const t1 = T0 + HOUR
    assert.equal(t.applyFix({ ...onPath(0.26), at_ms: t1 }, t1).accepted, true)

    const t2 = t1 + 10 * 60_000
    const out = t.applyFix({ ...onPath(0.22), at_ms: t2 }, t2)
    assert.equal(out.accepted, false)
    assert.equal(out.reason, 'backward')
  })

  test('a corroborated backward correction is accepted but still does not move it back', () => {
    const t = new PathTracker(ctx(), T0)
    const t1 = T0 + HOUR
    assert.equal(t.applyFix({ ...onPath(0.26), at_ms: t1 }, t1).accepted, true)
    const before = t.position(t1).routeFraction

    let now = t1
    let lastOutcome
    for (let i = 0; i < DEFAULT_PATH_CONFIG.backwardConfirmCount; i++) {
      now += 10 * 60_000
      lastOutcome = t.applyFix({ ...onPath(0.24), at_ms: now }, now)
    }
    assert.equal(lastOutcome?.accepted, true, 'corroborated backward fix should be accepted')
    assert.ok(t.position(now).routeFraction >= before, 'but progress must not reverse')
  })
})

describe('corrections change rate, not position', () => {
  test('a fix far ahead does not teleport the aircraft', () => {
    const t = new PathTracker(ctx(), T0)
    const t1 = T0 + HOUR
    const before = t.position(t1).routeFraction

    t.applyFix({ ...onPath(0.90), at_ms: t1 }, t1)
    const after = t.position(t1).routeFraction

    assert.equal(after, before, 'applying a fix must not move the aircraft directly')
  })

  test('but it does speed it up over the following minutes', () => {
    const baseline = new PathTracker(ctx(), T0)
    const nudged   = new PathTracker(ctx(), T0)

    const t1 = T0 + HOUR
    baseline.position(t1)
    nudged.applyFix({ ...onPath(0.90), at_ms: t1 }, t1)

    const t2 = t1 + 10 * 60_000
    assert.ok(
      nudged.position(t2).routeFraction > baseline.position(t2).routeFraction,
      'a fix ahead should increase rate',
    )
  })

  test('rate stays within the configured clamps', () => {
    const t = new PathTracker(ctx(), T0)
    const nominal = 1 / (4 * HOUR)

    let now = T0
    for (let i = 0; i < 30; i++) {
      now += 2 * 60_000
      t.applyFix({ ...onPath(0.99), at_ms: now }, now)   // always "way ahead"
    }
    const v = t.snapshot().v
    assert.ok(v <= nominal * DEFAULT_PATH_CONFIG.maxRateFactor * 1.001, `v too high: ${v}`)
    assert.ok(v >= 0, 'v must never be negative')
  })
})

describe('bad fixes are rejected', () => {
  test('off-path fix', () => {
    const t = new PathTracker(ctx(), T0)
    const now = T0 + HOUR
    // ~5 degrees of latitude off the route is far beyond maxOffPathKm.
    const out = t.applyFix({ lat: 38.0, lon: 44.0, at_ms: now }, now)
    assert.equal(out.accepted, false)
    assert.equal(out.reason, 'off_path')
  })

  test('impossible implied ground speed', () => {
    const t = new PathTracker(ctx(), T0)
    const t1 = T0 + HOUR
    // Seed slightly ahead of the estimate so this one is actually accepted and there is
    // a previous position to measure against.
    assert.equal(t.applyFix({ ...onPath(0.26), at_ms: t1 }, t1).accepted, true)

    // Two thirds of the route in one minute.
    const t2 = t1 + 60_000
    const out = t.applyFix({ ...onPath(0.95), at_ms: t2 }, t2)
    assert.equal(out.accepted, false)
    assert.equal(out.reason, 'impossible_speed')
  })

  test('stale fix', () => {
    const t = new PathTracker(ctx(), T0)
    const now = T0 + 2 * HOUR
    const out = t.applyFix({ ...onPath(0.4), at_ms: now - 45 * 60_000 }, now)
    assert.equal(out.accepted, false)
    assert.equal(out.reason, 'stale')
  })

  test('repeated off-path fixes flag divergence', () => {
    const t = new PathTracker(ctx(), T0)
    let now = T0
    for (let i = 0; i < DEFAULT_PATH_CONFIG.divergenceCount; i++) {
      now += 60_000
      t.applyFix({ lat: 39.0, lon: 44.0, at_ms: now }, now)
    }
    assert.equal(t.position(now).mode, 'diverged')
  })

  test('rejections are tallied for telemetry', () => {
    const t = new PathTracker(ctx(), T0)
    const now = T0 + HOUR
    t.applyFix({ lat: 38.0, lon: 44.0, at_ms: now }, now)
    assert.equal(t.snapshot().rejects.off_path, 1)
  })
})

describe('the ETA channel carries a flight with no fixes at all', () => {
  test('arrives close to the estimate having never received a position', () => {
    const t = new PathTracker(ctx(), T0)
    let now = T0
    for (let i = 0; i < 48; i++) {
      now += 5 * 60_000            // step to T0 + 4h
      t.position(now)
    }
    const s = t.position(T0 + 4 * HOUR).routeFraction
    assert.ok(s > 0.9, `expected near arrival with no fixes, got ${s}`)
  })

  test('a delayed arrival slows the aircraft rather than moving it', () => {
    const t = new PathTracker(ctx(), T0)
    const t1 = T0 + HOUR
    const before = t.position(t1).routeFraction

    t.setEta(T0 + 6 * HOUR, t1)             // 2 hours later than planned
    assert.equal(t.position(t1).routeFraction, before, 'ETA change must not move it')

    const onTime = new PathTracker(ctx(), T0)
    onTime.position(t1)
    const t2 = t1 + HOUR
    assert.ok(
      t.position(t2).routeFraction < onTime.position(t2).routeFraction,
      'a later ETA should reduce rate',
    )
  })

  test('an earlier arrival speeds it up', () => {
    const t = new PathTracker(ctx(), T0)
    const t1 = T0 + HOUR
    t.setEta(T0 + 3 * HOUR, t1)

    const onTime = new PathTracker(ctx(), T0)
    onTime.position(t1)

    const t2 = t1 + 30 * 60_000
    assert.ok(t.position(t2).routeFraction > onTime.position(t2).routeFraction)
  })
})

describe('routes with no stored path', () => {
  const noPath = () => ctx({ waypoints: [] })

  test('substitutes a great circle rather than going path-less', () => {
    const t = new PathTracker(noPath(), T0)
    assert.equal(t.synthesized, true)
    assert.ok(t.snapshot().totalKm > 0, 'synthesised path should have length')
  })

  test('fixes are still projected and accepted, not rejected as no_path', () => {
    const t = new PathTracker(noPath(), T0)
    const t1 = T0 + HOUR
    // A point on the great circle between the endpoints.
    const p = new PathTracker(noPath(), T0).position(T0 + 70 * 60_000)
    const out = t.applyFix({ lat: p.lat, lon: p.lon, at_ms: t1 }, t1)
    assert.equal(out.accepted, true, `expected acceptance, got ${out.reason}`)
    assert.equal(t.snapshot().rejects.no_path, 0)
  })

  test('still arrives on the ETA with no fixes', () => {
    const t = new PathTracker(noPath(), T0)
    let now = T0
    for (let i = 0; i < 48; i++) { now += 5 * 60_000; t.position(now) }
    assert.ok(t.position(T0 + 4 * HOUR).routeFraction > 0.9)
  })
})

describe('resumption and reporting', () => {
  test('a tracker created mid-flight starts at the elapsed fraction', () => {
    const t = new PathTracker(ctx(), T0 + 2 * HOUR)
    const s = t.position(T0 + 2 * HOUR).routeFraction
    assert.ok(Math.abs(s - 0.5) < 0.02, `expected ~0.5, got ${s}`)
  })

  test('isEstimated reflects whether a recent fix backs the position', () => {
    const t = new PathTracker(ctx(), T0)
    assert.equal(t.position(T0).isEstimated, true, 'no fix yet = estimated')

    const t1 = T0 + HOUR
    t.applyFix({ ...onPath(0.25), at_ms: t1 }, t1)
    assert.equal(t.position(t1).isEstimated, false)

    const t2 = t1 + 20 * 60_000
    assert.equal(t.position(t2).isEstimated, true, 'gone stale again')
  })

  test('reported position always lies on the route at the reported fraction', () => {
    const t = new PathTracker(ctx(), T0)
    let now = T0
    for (let i = 0; i < 20; i++) {
      now += 10 * 60_000
      const p = t.position(now)
      const [lat, lon] = interpolatePath(PATH, p.routeFraction)
      const offKm = haversineKm(p.lat, p.lon, lat, lon)
      assert.ok(offKm < 0.001, `position ${offKm} km off its own reported fraction`)
    }
  })
})

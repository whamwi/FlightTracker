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
    variants:       [PATH],
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

/**
 * Progress used to be strictly monotonic, and that was wrong.
 *
 * Strict monotonicity plus a rate clamped at zero means a tracker that has run AHEAD of the
 * aircraft can never come back, however much evidence arrives. FYC361 sat 208 km ahead of a
 * feed that could see it perfectly and only recovered when the tracker was rebuilt — which
 * presented as a 192 km jump.
 *
 * The guarantee is now bounded movement rather than no movement: a single fix cannot move the
 * aircraft backwards at all, and a corroborated one moves it by a fraction of the
 * disagreement. That keeps the property the invariant was protecting — no teleporting on bad
 * data — without the drift trap.
 */
/**
 * Distance between a tracker position and a place on the ground.
 *
 * Deliberately in kilometres on lat/lon rather than in route fraction. Every existing test
 * asserts `routeFraction` or `isEstimated`, which means none of them would notice if the
 * projection back to coordinates broke — and coordinates are the only thing a reader sees.
 */
function kmApart(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return haversineKm(a.lat, a.lon, b.lat, b.lon)
}

describe('progress moves backwards only on corroboration, and only a little', () => {
  test('no single step is a teleport, however insistent the fixes', () => {
    const t = new PathTracker(ctx(), T0)
    let prev = t.position(T0).routeFraction

    for (let i = 1; i <= 40; i++) {
      const now = T0 + i * 5 * 60_000
      // Every fix claims the aircraft is far behind where we think it is.
      t.applyFix({ ...onPath(0.01), at_ms: now }, now)
      const s = t.position(now).routeFraction
      // Backward movement is capped at the correction factor times the largest disagreement
      // the route allows (1.0), with a little headroom for the forward rate in the same step.
      assert.ok(
        s - prev >= -DEFAULT_PATH_CONFIG.backwardCorrectionFactor,
        `step ${i} reversed too far: ${prev} → ${s}`,
      )
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

  /**
   * A tracker that has run AHEAD of the aircraft, which is the only case this machinery is
   * for, and the one three earlier versions of these tests failed to construct.
   *
   * Getting the direction wrong is easy and silent. The constructor seeds `s` from elapsed
   * time, so at t0 + 1 h on a 4 h flight the seed is 0.25 — and a fix at 0.40 is then FORWARD
   * of the tracker, exercising the rate correction that has always worked while the backward
   * path never runs at all. Every assertion still passes, and proves nothing.
   *
   * Two hours in the seed is 0.50. A fix at 0.30 is genuinely behind it: ~300 km ahead of an
   * aeroplane the feed can see perfectly, which is FYC361 as observed.
   */
  const AHEAD_AT   = T0 + 2 * HOUR   // seeded s = 0.50
  const AHEAD_TRUTH = 0.30           // where the aircraft really is

  test('a corroborated backward correction actually moves it back', () => {
    const t    = new PathTracker(ctx(), T0)
    // A twin that never hears the fixes, so the comparison isolates the correction from the
    // rate. Comparing against the tracker's own earlier position would fail on a correct
    // implementation: the aircraft legitimately advances between fixes.
    const twin = new PathTracker(ctx(), T0)

    let now = AHEAD_AT
    let lastOutcome
    // Three polls: the first is the free first fix, the second is refused for want of
    // corroboration, the third is believed.
    for (let i = 0; i < 3; i++) {
      lastOutcome = t.applyFix({ ...onPath(AHEAD_TRUTH), at_ms: now }, now)
      now += 60_000
    }
    assert.equal(lastOutcome?.accepted, true, 'corroborated backward fix should be accepted')

    const later = now + 60_000
    assert.ok(
      t.position(later).routeFraction < twin.position(later).routeFraction - 1e-6,
      'corroborated evidence should pull it back relative to an uncorrected tracker',
    )
  })

  /**
   * The property that replaced monotonicity, and the one that actually protects the reader.
   *
   * An earlier attempt applied the correction inside applyFix, which put the whole
   * disagreement into one animation frame — 73 km on a badly drifted flight. That passes a
   * test asserting "it moved back" and fails the only thing a viewer cares about. Asserted in
   * kilometres between consecutive frames, because that is what the eye reads.
   */
  test('no frame moves the aircraft further than the eye reads as motion', () => {
    const t = new PathTracker(ctx(), T0)
    let now = AHEAD_AT

    let prev = t.position(now)
    let worst = 0
    for (let poll = 0; poll < 8; poll++) {
      for (let f = 0; f < 60; f++) {
        now += 1000
        const p = t.position(now)
        worst = Math.max(worst, kmApart(p, prev))
        prev = p
      }
      t.applyFix({ ...onPath(AHEAD_TRUTH), at_ms: now }, now)
      const p = t.position(now)
      worst = Math.max(worst, kmApart(p, prev))
      prev = p
    }
    // A second of cruise is ~0.25 km. Anything near that is motion; 73 km is a teleport.
    assert.ok(worst < 1, `a frame jumped ${worst.toFixed(1)} km`)
  })

  /**
   * The implied-speed guard divides by the interval since the last accepted fix, so a fix at
   * or before that moment leaves it with nothing to divide by. It used to fall through as
   * though it had passed — the only along-track sanity check on a fix, silently skipped.
   *
   * Reachable without an attacker: a feed merging several ADS-B receivers emits out-of-order
   * timestamps routinely, and a rejected fix leaves the accepted-timestamp behind, so the
   * next one can easily arrive "before" it.
   */
  test('a fix that predates the last accepted one is discarded, not waved through', () => {
    const t  = new PathTracker(ctx(), T0)
    const t1 = T0 + HOUR
    assert.equal(t.applyFix({ ...onPath(0.26), at_ms: t1 }, t1).accepted, true)

    // Same wall clock, but the fix itself claims to be older than the one already believed.
    const out = t.applyFix({ ...onPath(0.30), at_ms: t1 - 30_000 }, t1)
    assert.equal(out.accepted, false, 'an out-of-order fix must not be accepted')
    assert.equal(out.reason, 'stale')
  })

  test('drift converges instead of persisting', () => {
    const t = new PathTracker(ctx(), T0)
    const truth = AHEAD_TRUTH
    let now = AHEAD_AT
    const startGap = kmApart(t.position(now), onPath(truth))
    // Sixty-second polls with frames between them, which is what the feed and the animation
    // actually do. Ten-minute polls make this scenario dishonest rather than demanding: the
    // fix is pinned at one fraction while the tracker legitimately flies on, so most of the
    // residual being measured is an aeroplane that the test is pretending never moved.
    for (let i = 0; i < 20; i++) {
      for (let f = 0; f < 60; f++) { now += 1000; t.position(now) }
      t.applyFix({ ...onPath(truth), at_ms: now }, now)
    }
    // Tight deliberately. An earlier attempt settled into a permanent 67 km residual with a
    // 36 km sawtooth on every poll, and a loose threshold called that convergence. It has to
    // actually arrive, not merely stop getting worse.
    const gapKm = kmApart(t.position(now), onPath(truth))
    assert.ok(
      gapKm < startGap * 0.6,
      `drift did not converge: ${Math.round(startGap)} km -> ${Math.round(gapKm)} km`,
    )
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

describe('routes with more than one corridor', () => {
  // Same endpoints, but bowing well north of PATH — far enough apart that a fix on one
  // is nowhere near the other, as with IST-DAM's two real corridors.
  const NORTH: Waypoint[] = [
    { f: 0.00, lat: 33.0, lon: 36.0 },
    { f: 0.25, lat: 35.5, lon: 40.0 },
    { f: 0.50, lat: 36.0, lon: 44.0 },
    { f: 0.75, lat: 35.5, lon: 48.0 },
    { f: 1.00, lat: 33.0, lon: 52.0 },
  ]
  const both = () => ctx({ variants: [PATH, NORTH] })
  const onNorth = (f: number) => {
    const [lat, lon] = interpolatePath(NORTH, f)
    return { lat, lon }
  }

  test('a fix on the second corridor is accepted, not rejected as off-path', () => {
    const t = new PathTracker(both(), T0)
    const t1 = T0 + HOUR
    const out = t.applyFix({ ...onNorth(0.26), at_ms: t1 }, t1)
    assert.equal(out.accepted, true, `expected acceptance, got ${out.reason}`)
  })

  test('the flight switches to whichever corridor its fixes match', () => {
    const t = new PathTracker(both(), T0)
    assert.equal(t.snapshot().variant, 0, 'starts on the most-observed corridor')

    let now = T0
    for (let i = 0; i < 3; i++) {
      now += 20 * 60_000
      t.applyFix({ ...onNorth(0.2 + i * 0.08), at_ms: now }, now)
    }
    assert.equal(t.snapshot().variant, 1, 'should have moved to the matching corridor')
    assert.ok(t.snapshot().variantSwitches >= 1)
  })

  test('staying on the matching corridor does not cause switching', () => {
    const t = new PathTracker(both(), T0)
    let now = T0
    for (let i = 0; i < 4; i++) {
      now += 20 * 60_000
      t.applyFix({ ...onPath(0.2 + i * 0.08), at_ms: now }, now)
    }
    assert.equal(t.snapshot().variant, 0)
    assert.equal(t.snapshot().variantSwitches, 0)
  })

  test('a fix matching neither corridor still reads as off-path', () => {
    const t = new PathTracker(both(), T0)
    const now = T0 + HOUR
    const out = t.applyFix({ lat: 25.0, lon: 44.0, at_ms: now }, now)
    assert.equal(out.accepted, false)
    assert.equal(out.reason, 'off_path')
  })
})

describe('routes with no stored path', () => {
  const noPath = () => ctx({ variants: [] })

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

describe('a newly created tracker defers to its first real fix', () => {
  // The constructor seeds `s` from elapsed time, which assumes the route is flown at its
  // average speed. A climbing aircraft is well short of that, so a tracker created shortly
  // after departure starts ahead of the aeroplane and — progress being monotonic and the
  // correction being rate-only — could never get back. Measured 52 km of drift on a
  // DAM–AMS departure before this.
  test('the first fix may pull it back while the position is still only a guess', () => {
    // Created an hour in, so the seeded guess is s = 0.25.
    const born = T0 + HOUR
    const t = new PathTracker(ctx(), born)
    assert.ok(Math.abs(t.position(born).routeFraction - 0.25) < 1e-6)

    // The aircraft is really at 0.20 — behind the schedule's opinion. ONE fix settles it:
    // there is nothing to corroborate a first fix against, because the only thing it
    // contradicts is the constructor's guess.
    const now = born + 10_000
    const out = t.applyFix({ ...onPath(0.20), at_ms: now }, now)
    assert.equal(out.accepted, true, 'a first fix has no guess worth defending against it')
    assert.ok(
      Math.abs(t.position(now).routeFraction - 0.20) < 1e-3,
      'first accepted fix should place the aircraft, not just adjust the rate',
    )
  })

  /**
   * The launch jump: the marker sat on the stored path for a poll, then moved.
   *
   * The backward gate used to reject the first fix — asking a second opinion before
   * overruling a value that was never an observation — and the snap then placed the aircraft
   * on the fix after. Two steps where one was warranted, visible on every app start.
   */
  test('no wasted poll: the marker is placed on the first fix, not the second', () => {
    const born = T0 + 2 * HOUR
    const t = new PathTracker(ctx(), born)
    const seeded = t.position(born).routeFraction

    const truth = 0.44
    const out = t.applyFix({ ...onPath(truth), at_ms: born }, born)
    assert.equal(out.accepted, true, 'the first fix must not be rejected as backward')

    const movedKm = kmApart(t.position(born), onPath(seeded))
    assert.ok(movedKm > 50, `first fix should have placed it; moved only ${movedKm.toFixed(1)} km`)
    assert.ok(
      kmApart(t.position(born), onPath(truth)) < 1,
      'and placed it where the fix actually says it is',
    )
  })

  test('but only backwards — a first fix ahead must not teleport it', () => {
    const born = T0 + HOUR
    const t = new PathTracker(ctx(), born)
    const before = t.position(born).routeFraction

    t.applyFix({ ...onPath(0.60), at_ms: born }, born)
    assert.equal(t.position(born).routeFraction, before,
      'a forward disagreement is still worked off through the rate')
  })

  test('and only while it is new — a late first fix cannot reverse it', () => {
    const born = T0 + HOUR
    const t = new PathTracker(ctx(), born)
    const late = born + DEFAULT_PATH_CONFIG.initialSnapWindowMs + 60_000
    const before = t.position(late).routeFraction

    t.applyFix({ ...onPath(0.20), at_ms: late }, late)
    assert.ok(t.position(late).routeFraction >= before,
      'past the startup window the seeded position has been on screen too long to move')
  })

  test('the rate follows the reported ground speed once one is known', () => {
    const born = T0 + HOUR
    const slow = new PathTracker(ctx(), born)
    const fast = new PathTracker(ctx(), born)

    slow.applyFix({ ...onPath(0.25), at_ms: born, gs_kts: 200 }, born)
    fast.applyFix({ ...onPath(0.25), at_ms: born, gs_kts: 500 }, born)

    const later = born + 10 * 60_000
    assert.ok(
      fast.position(later).routeFraction > slow.position(later).routeFraction,
      'a slower aircraft must advance more slowly than a faster one on the same route',
    )
  })
})

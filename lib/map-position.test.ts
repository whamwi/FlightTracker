import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPlausibleFix,
  dropSentinelFixes,
  inferPosition,
  greatCirclePath,
} from './map-position.ts'

/**
 * The corrupt sweep of 16 Aug, verbatim from aircraft_last_seen.
 *
 * Kept as real rows rather than invented ones: the guard has to survive the shape the aggregator
 * actually produced, including the genuine altitudes and the one row whose speed looked fine.
 */
const AMMAN = { lat: 31.71711, lon: 35.999341 }
const CORRUPT_SWEEP = [
  { hex: '424c00', ...AMMAN, alt_baro: 32000, gs: 0.7, track: 0 },    // M-SSML
  { hex: '710db9', ...AMMAN, alt_baro: 31000, gs: 0.7, track: 0 },    // KNE252
  { hex: '71145e', ...AMMAN, alt_baro: 17850, gs: 0.7, track: 0 },    // FAD562
  { hex: '706132', ...AMMAN, alt_baro: 37025, gs: 0.7, track: 0 },    // JZR174
  { hex: '010169', ...AMMAN, alt_baro: 35000, gs: 456, track: 154.16 }, // PER002 — speed intact
]

const REAL = { hex: '4bb290', lat: 34.9912, lon: 37.8703, alt_baro: 33000, gs: 448, track: 335 }

describe('the physics guard', () => {
  test('rejects cruise altitude at a walking pace', () => {
    for (const fix of CORRUPT_SWEEP.filter(f => f.gs < 50)) {
      assert.equal(isPlausibleFix(fix), false, `${fix.hex} at ${fix.gs} kt / ${fix.alt_baro} ft`)
    }
  })

  test('accepts a genuine fix', () => {
    assert.equal(isPlausibleFix(REAL), true)
  })

  test('does not reject a slow aircraft near the ground', () => {
    // Taxiing and landing rollout are exactly the case a naive speed floor would break, and the
    // map is meant to show an aircraft on the runway at Damascus.
    assert.equal(isPlausibleFix({ hex: 'a', lat: 33.41, lon: 36.51, alt_baro: 2000, gs: 12 }), true)
    assert.equal(isPlausibleFix({ hex: 'a', lat: 33.41, lon: 36.51, alt_baro: 0, gs: 0 }), true)
  })

  test('rejects missing, out-of-range and null-island coordinates', () => {
    assert.equal(isPlausibleFix({ lat: null, lon: 36 }), false)
    assert.equal(isPlausibleFix({ lat: 'x', lon: 36 }), false)
    assert.equal(isPlausibleFix({ lat: 91, lon: 36 }), false)
    assert.equal(isPlausibleFix({ lat: 0, lon: 0 }), false)
  })

  test('a fix with no altitude or speed is judged on position alone', () => {
    // FR24 rows carry neither. Refusing them would empty the map to spite the aggregator.
    assert.equal(isPlausibleFix({ hex: 'b', lat: 33.4, lon: 36.5 }), true)
  })
})

describe('the sentinel guard', () => {
  test('discards every aircraft sharing one coordinate, including the plausible one', () => {
    const kept = dropSentinelFixes(CORRUPT_SWEEP)
    assert.equal(kept.length, 0, 'PER002 looked fine on its own and was still a placeholder')
  })

  test('leaves a healthy sweep untouched', () => {
    const sweep = [
      REAL,
      { hex: '06a0ac', lat: 33.6923, lon: 38.0303, alt_baro: 38975, gs: 470, track: 200 },
      { hex: '3c7984', lat: 34.3721, lon: 37.4769, alt_baro: 33375, gs: 455, track: 196 },
    ]
    assert.deepEqual(dropSentinelFixes(sweep), sweep)
  })

  test('one aircraft alone at a coordinate survives', () => {
    const sweep = [{ hex: 'x', ...AMMAN, alt_baro: 3000, gs: 180 }, REAL]
    assert.equal(dropSentinelFixes(sweep).length, 2)
  })

  test('two rows without a hex still count as two claimants', () => {
    const sweep = [{ ...AMMAN, gs: 400, alt_baro: 30000 }, { ...AMMAN, gs: 410, alt_baro: 31000 }]
    assert.equal(dropSentinelFixes(sweep).length, 0)
  })

  test('the same aircraft reported twice is not a sentinel', () => {
    // A duplicate row for one airframe is ordinary; it is two IDENTITIES that cannot share a spot.
    const sweep = [{ hex: 'dup', ...AMMAN, gs: 400, alt_baro: 30000 },
                   { hex: 'dup', ...AMMAN, gs: 400, alt_baro: 30000 }]
    assert.equal(dropSentinelFixes(sweep).length, 2)
  })
})

describe('inference along the corridor', () => {
  const DEP = Date.parse('2026-08-16T10:00:00Z')
  const ARR = Date.parse('2026-08-16T12:00:00Z')
  // DAM -> KWI, the flight that had no fix at all on 16 Aug.
  const PATH = greatCirclePath(33.411, 36.514, 29.227, 47.969)

  test('at departure it is over the origin, at arrival over the destination', () => {
    const a = inferPosition(DEP, ARR, PATH, DEP)!
    assert.ok(Math.abs(a.lat - 33.411) < 0.01 && Math.abs(a.lon - 36.514) < 0.01)
    const b = inferPosition(DEP, ARR, PATH, ARR)!
    assert.ok(Math.abs(b.lat - 29.227) < 0.01 && Math.abs(b.lon - 47.969) < 0.01)
  })

  test('halfway through the flight it is between the two, and pointing along the route', () => {
    const p = inferPosition(DEP, ARR, PATH, DEP + 3_600_000)!
    assert.ok(p.lat < 33.411 && p.lat > 29.227, 'south of Damascus, north of Kuwait')
    assert.ok(p.lon > 36.514 && p.lon < 47.969, 'east of Damascus, west of Kuwait')
    assert.ok(p.track > 90 && p.track < 180, `heading southeast, got ${p.track}`)
  })

  test('it is a function of its inputs and nothing else', () => {
    // The property the client trackers could not offer: two callers at one instant agree, and
    // asking twice cannot move anything, because there is no state to move.
    const t = DEP + 1_234_567
    assert.deepEqual(inferPosition(DEP, ARR, PATH, t), inferPosition(DEP, ARR, PATH, t))
  })

  test('before departure and after arrival it pins rather than running off the path', () => {
    const before = inferPosition(DEP, ARR, PATH, DEP - 3_600_000)!
    assert.ok(Math.abs(before.lat - 33.411) < 0.01, 'still at the gate, not behind it')
    const after = inferPosition(DEP, ARR, PATH, ARR + 3_600_000)!
    assert.ok(Math.abs(after.lat - 29.227) < 0.01, 'landed, not continuing past Kuwait')
  })

  test('nonsense schedules produce nothing rather than a wrong answer', () => {
    assert.equal(inferPosition(NaN, ARR, PATH, DEP), null)
    assert.equal(inferPosition(ARR, DEP, PATH, DEP), null, 'arrival before departure')
    assert.equal(inferPosition(DEP, DEP, PATH, DEP), null, 'zero-length flight')
    assert.equal(inferPosition(DEP, ARR, [], DEP), null, 'no corridor')
  })

  test('an inferred position says so, and carries no fix age', () => {
    const p = inferPosition(DEP, ARR, PATH, DEP + 60_000)!
    assert.equal(p.source, 'inferred')
    assert.equal(p.fix_age_s, 0)
  })
})

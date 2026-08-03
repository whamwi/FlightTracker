/**
 * Unit tests for cross-track sampling.
 *
 * Run with:  node --experimental-strip-types --test lib/path-samples.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { indexPaths, buildSamples, CRUISE_MIN_ALT_FT, CRUISE_MIN_GS_KTS } from './path-samples.ts'
import { interpolatePath, type Waypoint } from './flight-predictor.ts'

// West→east along a line of latitude, so "off path" is a straightforward north/south offset.
const PATH: Waypoint[] = [
  { f: 0.00, lat: 33.0, lon: 36.0 },
  { f: 0.25, lat: 33.0, lon: 40.0 },
  { f: 0.50, lat: 33.0, lon: 44.0 },
  { f: 0.75, lat: 33.0, lon: 48.0 },
  { f: 1.00, lat: 33.0, lon: 52.0 },
]

const PATHS = indexPaths([{ dep_iata: 'DAM', arr_iata: 'DXB', variant: 1, waypoints: PATH }])
const NOW = 1_700_000_000_000

function ac(over: Record<string, unknown> = {}) {
  const [lat, lon] = interpolatePath(PATH, 0.5)
  return {
    flight: 'SYR100 ', board_match: true,
    dep_iata: 'DAM', arr_iata: 'DXB',
    lat, lon, alt_baro: 35_000, gs: 450, seen: 0,
    ...over,
  }
}

describe('cross-track sampling', () => {
  test('an aircraft on the corridor records almost no offset', () => {
    const { samples } = buildSamples([ac()], PATHS, NOW)
    assert.equal(samples.length, 1)
    assert.ok(samples[0].off_path_km < 1, `expected on-path, got ${samples[0].off_path_km} km`)
    assert.ok(Math.abs(samples[0].s - 0.5) < 0.02)
    assert.equal(samples[0].variant, 1)
  })

  test('an aircraft flying a parallel corridor records the offset', () => {
    // One degree of latitude is ~111 km, and the path runs along a parallel.
    const [lat, lon] = interpolatePath(PATH, 0.5)
    const { samples } = buildSamples([ac({ lat: lat + 1 })], PATHS, NOW)
    assert.equal(samples.length, 1)
    assert.ok(samples[0].off_path_km > 100 && samples[0].off_path_km < 125,
      `expected ~111 km, got ${samples[0].off_path_km}`)
    void lon
  })

  test('the best-fitting corridor wins when a route has more than one', () => {
    const north: Waypoint[] = PATH.map(w => ({ ...w, lat: w.lat + 2 }))
    const both = indexPaths([
      { dep_iata: 'DAM', arr_iata: 'DXB', variant: 1, waypoints: PATH },
      { dep_iata: 'DAM', arr_iata: 'DXB', variant: 2, waypoints: north },
    ])
    const [lat] = interpolatePath(north, 0.5)
    const { samples } = buildSamples([ac({ lat })], both, NOW)
    assert.equal(samples[0].variant, 2, 'should attribute the sample to the corridor it was on')
    assert.ok(samples[0].off_path_km < 1)
  })
})

describe('only cruise is evidence', () => {
  // Departure and arrival manoeuvring leaves the corridor by design — vectors, holds,
  // runway in use — so it must not teach the learner that the corridor is wrong.
  test('a climbing aircraft is not sampled', () => {
    const { samples, skipped } = buildSamples([ac({ alt_baro: CRUISE_MIN_ALT_FT - 1 })], PATHS, NOW)
    assert.equal(samples.length, 0)
    assert.equal(skipped.not_cruise, 1)
  })

  test('a slow aircraft is not sampled', () => {
    const { samples, skipped } = buildSamples([ac({ gs: CRUISE_MIN_GS_KTS - 1 })], PATHS, NOW)
    assert.equal(samples.length, 0)
    assert.equal(skipped.not_cruise, 1)
  })

  test('an aircraft on the ground is not sampled', () => {
    const { samples } = buildSamples([ac({ alt_baro: 'ground', gs: 0 })], PATHS, NOW)
    assert.equal(samples.length, 0)
  })
})

describe('rows that cannot teach anything are skipped', () => {
  test('unmatched traffic', () => {
    const { samples, skipped } = buildSamples([ac({ board_match: false })], PATHS, NOW)
    assert.equal(samples.length, 0)
    assert.equal(skipped.not_board_matched, 1)
  })

  test('a flight with no known route', () => {
    const { samples, skipped } = buildSamples([ac({ arr_iata: null })], PATHS, NOW)
    assert.equal(samples.length, 0)
    assert.equal(skipped.no_route, 1)
  })

  test('a route with no stored corridor', () => {
    const { samples, skipped } = buildSamples([ac({ arr_iata: 'ZZZ' })], PATHS, NOW)
    assert.equal(samples.length, 0)
    assert.equal(skipped.no_path, 1)
  })

  test('a stale fix, which would be projected in the wrong place', () => {
    const { samples, skipped } = buildSamples([ac({ seen: 300 })], PATHS, NOW)
    assert.equal(samples.length, 0)
    assert.equal(skipped.stale_fix, 1)
  })
})

describe('sample metadata', () => {
  test('the operating day comes from the fix, not from today', () => {
    // A fix 10 minutes before midnight UTC belongs to that day, even if the run crosses over.
    const justBeforeMidnight = Date.parse('2026-08-03T23:50:00Z')
    const { samples } = buildSamples([ac({ seen: 0 })], PATHS, justBeforeMidnight)
    assert.equal(samples[0].flight_date, '2026-08-03')
  })

  test('seen_at is backdated by the fix age', () => {
    const { samples } = buildSamples([ac({ seen: 30 })], PATHS, NOW)
    assert.equal(Date.parse(samples[0].seen_at), NOW - 30_000)
  })

  test('the callsign is trimmed', () => {
    const { samples } = buildSamples([ac()], PATHS, NOW)
    assert.equal(samples[0].callsign, 'SYR100')
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { climbRamp, climbAdjustedFraction, CLIMB_FULL_MIN } from './climb-profile.ts'

const M = (min: number) => min * 60_000

/**
 * The measurement the model exists to respect: minutes since wheels-up against the share of the
 * linear projection an aircraft has actually covered. ~2,700 fixes, three days of departures.
 *
 * Kept here rather than only in the comment so a future adjustment has to argue with the numbers.
 */
const MEASURED: [number, number][] = [
  [1, 0.62], [2, 0.58], [3, 0.48], [4, 0.51], [5, 0.53], [6, 0.58],
  [7, 0.57], [8, 0.60], [9, 0.65], [10, 0.69], [11, 0.72], [12, 0.77],
]

test('the ghost never runs ahead of where aircraft actually get to', () => {
  for (const [min, actual] of MEASURED) {
    const modelled = climbRamp(M(min))
    assert.ok(modelled <= actual,
      `at ${min} min the model projects ${modelled.toFixed(2)} of linear, ` +
      `but aircraft average only ${actual.toFixed(2)} — the marker would sit ahead of the flight`)
  }
})

test('and does not lag so far that it stops describing the flight', () => {
  // Half the measured share is the floor of usefulness: below that the ghost is nearer the airport
  // than the aircraft by more than the aircraft has flown.
  for (const [min, actual] of MEASURED) {
    assert.ok(climbRamp(M(min)) >= actual * 0.5, `at ${min} min the model is too far behind`)
  }
})

test('RJ434 out of Aleppo: the case that surfaced this', () => {
  // Departed 13:31:39, we learned of it at 13:37:09, first fix nine seconds later at 20.6 km on a
  // 509 km route with a 54-minute block. Linear put it at 52 km — the jump the reader saw when the
  // fix arrived and pulled the marker back.
  const elapsed = M(5.5)
  const block   = M(54)
  const routeKm = 509
  const linear   = (elapsed / block) * routeKm
  const modelled = climbAdjustedFraction(elapsed, block) * routeKm
  assert.ok(linear > 50, `linear projection was ${linear.toFixed(0)} km`)
  assert.ok(modelled < 25,
    `damped projection is ${modelled.toFixed(0)} km, and the aircraft was at 20.6 km`)
})

test('nothing is damped once the climb is over', () => {
  assert.equal(climbRamp(M(CLIMB_FULL_MIN)), 1)
  assert.equal(climbRamp(M(90)), 1)
  // No standing lag: a flight two thirds through its block reads two thirds through.
  assert.equal(climbAdjustedFraction(M(60), M(90)), 60 / 90)
})

test('a flight with no block time yields no opinion rather than infinity', () => {
  assert.equal(climbAdjustedFraction(M(10), 0), 0)
})

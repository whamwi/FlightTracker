import { test } from 'node:test'
import assert from 'node:assert/strict'
import { carryArrival } from './flight-leg.ts'

/*
 * The real numbers from the flight that exposed this. SYR444 flies Istanbul–Damascus daily,
 * so the callsign-keyed state from one day meets the next day's flight.
 */
const YESTERDAY_ARRIVAL = '2026-08-06T18:48:00.000Z'  // landed 21:48 Damascus
const TODAY_DEPARTURE   = '2026-08-07T17:07:09.000Z'  // off the ground, still over Turkey

test('drops an arrival that predates this leg — the SYR444 case', () => {
  assert.equal(carryArrival(YESTERDAY_ARRIVAL, TODAY_DEPARTURE), null)
})

test('keeps a genuine arrival from the same leg', () => {
  const arr = '2026-08-07T19:32:00.000Z'
  assert.equal(carryArrival(arr, TODAY_DEPARTURE), arr)
})

test('survives drift in our own inferred departure', () => {
  // writeInboundDep recomputes the departure estimate every poll, so it moves by minutes
  // within a single leg. That must never look like a new leg.
  const arr = '2026-08-07T19:32:00.000Z'
  for (const dep of ['2026-08-07T17:01:00.000Z', '2026-08-07T17:14:00.000Z']) {
    assert.equal(carryArrival(arr, dep), arr)
  }
})

test('keeps the arrival when there is no departure to compare against', () => {
  const arr = '2026-08-07T19:32:00.000Z'
  assert.equal(carryArrival(arr, null), arr)
  assert.equal(carryArrival(arr, undefined), arr)
})

test('no stored arrival stays null', () => {
  assert.equal(carryArrival(null, TODAY_DEPARTURE), null)
  assert.equal(carryArrival(undefined, TODAY_DEPARTURE), null)
})

test('an unparseable timestamp is kept rather than silently dropped', () => {
  assert.equal(carryArrival('not-a-date', TODAY_DEPARTURE), 'not-a-date')
  assert.equal(carryArrival(YESTERDAY_ARRIVAL, 'not-a-date'), YESTERDAY_ARRIVAL)
})

test('an arrival exactly at the departure instant is kept', () => {
  assert.equal(carryArrival(TODAY_DEPARTURE, TODAY_DEPARTURE), TODAY_DEPARTURE)
})

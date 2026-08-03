/**
 * Unit tests for TrackerStore.
 *
 * Run with:  node --experimental-strip-types --test lib/tracker-store.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { TrackerStore, type FlightInput } from './tracker-store.ts'
import { interpolatePath, haversineKm, type Waypoint } from './flight-predictor.ts'

const PATH: Waypoint[] = [
  { f: 0.00, lat: 33.0, lon: 36.0 },
  { f: 0.25, lat: 33.0, lon: 40.0 },
  { f: 0.50, lat: 33.0, lon: 44.0 },
  { f: 0.75, lat: 33.0, lon: 48.0 },
  { f: 1.00, lat: 33.0, lon: 52.0 },
]

const T0   = 1_700_000_000_000
const HOUR = 3_600_000

function flight(over: Partial<FlightInput> = {}): FlightInput {
  return {
    callsign:       'TEST1',
    variants:       [PATH],
    dep_coords:     [33.0, 36.0],
    arr_coords:     [33.0, 52.0],
    departed_at_ms: T0,
    eta_ms:         T0 + 4 * HOUR,
    duration_ms:    4 * HOUR,
    ...over,
  }
}

const onPath = (f: number) => {
  const [lat, lon] = interpolatePath(PATH, f)
  return { lat, lon }
}

describe('the store answers at any instant', () => {
  test('position is available between polls and keeps moving', () => {
    const s = new TrackerStore()
    s.update([flight()], T0)

    // The tracker advances forward only — querying a past instant reports the current
    // state rather than rewinding — so the baseline has to be taken before stepping.
    const start = s.position('TEST1', T0)!.routeFraction

    // Sample at animation cadence between two ten-second polls.
    let prev = s.position('TEST1', T0)!
    for (let dt = 16; dt <= 10_000; dt += 16) {
      const p = s.position('TEST1', T0 + dt)!
      assert.ok(p.routeFraction >= prev.routeFraction, 'must not go backwards between frames')
      prev = p
    }
    assert.ok(prev.routeFraction > start, 'should have advanced without any new fix')
  })

  test('frame-to-frame movement is small enough to look continuous', () => {
    const s = new TrackerStore()
    s.update([flight()], T0)

    let prev = s.position('TEST1', T0)!
    let worst = 0
    for (let dt = 16; dt <= 60_000; dt += 16) {
      const p = s.position('TEST1', T0 + dt)
      if (!p) break
      worst = Math.max(worst, haversineKm(prev.lat, prev.lon, p.lat, p.lon))
      prev = p
    }
    // ~1490 km over 4 h is roughly 6 m per 16 ms frame.
    assert.ok(worst < 0.05, `frame step too large: ${worst} km`)
  })
})

describe('feeding the store', () => {
  test('a repeated fix is not applied twice', () => {
    const s = new TrackerStore()
    const fix = { ...onPath(0.30), at_ms: T0 + HOUR }

    s.update([flight({ fix })], T0 + HOUR)
    s.update([flight({ fix })], T0 + HOUR + 10_000)
    s.update([flight({ fix })], T0 + HOUR + 20_000)

    const snap = s.snapshot('TEST1')!
    const applied = Object.values(snap.rejects).reduce((a, b) => a + b, 0)
    // Whether accepted or rejected, it should have been offered exactly once.
    assert.ok(applied <= 1, `same fix processed more than once: ${applied} rejects`)
  })

  test('a changed ETA is passed through as a rate change', () => {
    const s = new TrackerStore()
    s.update([flight()], T0)
    const before = s.position('TEST1', T0 + HOUR)!.routeFraction

    s.update([flight({ eta_ms: T0 + 8 * HOUR })], T0 + HOUR)
    assert.equal(s.position('TEST1', T0 + HOUR)!.routeFraction, before,
      'an ETA change must not move the aircraft')

    const onTime = new TrackerStore()
    onTime.update([flight()], T0)
    assert.ok(
      s.position('TEST1', T0 + 2 * HOUR)!.routeFraction <
      onTime.position('TEST1', T0 + 2 * HOUR)!.routeFraction,
      'a later ETA should slow it down',
    )
  })

  test('a flight missing from the update is dropped', () => {
    const s = new TrackerStore()
    s.update([flight(), flight({ callsign: 'TEST2' })], T0)
    assert.equal(s.callsigns().length, 2)

    s.update([flight()], T0 + 10_000)
    assert.deepEqual(s.callsigns(), ['TEST1'])
    assert.equal(s.position('TEST2', T0 + 10_000), null)
  })

  test('an unknown callsign returns null rather than throwing', () => {
    const s = new TrackerStore()
    assert.equal(s.position('NOPE', T0), null)
    assert.equal(s.snapshot('NOPE'), null)
  })

  test('a flight with no stored corridor still tracks', () => {
    const s = new TrackerStore()
    s.update([flight({ variants: [] })], T0)
    const p = s.position('TEST1', T0 + HOUR)
    assert.ok(p, 'should still have a position')
    assert.ok(p!.routeFraction > 0, 'and should be making progress')
  })
})

describe('a large arrival correction rebuilds the tracker', () => {
  // A flight arrived carrying an ETA a day late. The rate is remaining path over remaining
  // time, so the marker crawled from its origin while the aircraft flew; correcting the ETA
  // could then only change the rate, and monotonic progress meant the accumulated error
  // could never be unwound. Such a correction has to start the tracker over.
  test('progress is discarded when the arrival estimate moves by hours', () => {
    const store = new TrackerStore()
    const dep = T0
    const badEta = dep + 26 * HOUR          // a day-wrapped arrival
    const input = (eta: number) => ([{
      callsign: 'RB1', variants: [PATH],
      dep_coords: [33.0, 36.0] as [number, number],
      arr_coords: [33.0, 52.0] as [number, number],
      departed_at_ms: dep, eta_ms: eta, duration_ms: eta - dep,
    }])

    store.update(input(badEta), dep)
    // An hour in, the bad ETA has barely moved it.
    const crawled = store.position('RB1', dep + HOUR)!.routeFraction
    assert.ok(crawled < 0.1, `expected a crawl, got ${crawled}`)

    // The feed corrects to a sane three-hour block.
    store.update(input(dep + 3 * HOUR), dep + HOUR)
    const after = store.position('RB1', dep + HOUR)!.routeFraction
    assert.ok(after > crawled,
      'a corrected arrival should reset progress, not leave it stranded behind')
  })

  test('an ordinary revision still only changes the rate', () => {
    const store = new TrackerStore()
    const dep = T0
    const input = (eta: number) => ([{
      callsign: 'RB2', variants: [PATH],
      dep_coords: [33.0, 36.0] as [number, number],
      arr_coords: [33.0, 52.0] as [number, number],
      departed_at_ms: dep, eta_ms: eta, duration_ms: eta - dep,
    }])

    store.update(input(dep + 4 * HOUR), dep)
    const before = store.position('RB2', dep + HOUR)!.routeFraction
    // Twenty minutes late — a normal delay, not a correction.
    store.update(input(dep + 4 * HOUR + 20 * 60_000), dep + HOUR)
    const after = store.position('RB2', dep + HOUR)!.routeFraction
    assert.equal(after, before, 'position must not move on a routine revision')
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasArrived, effectiveStatus, rankInstance, type StatusFacts } from './flight-status.ts'

const T = (s: string) => Date.parse(`2026-08-14T${s}:00Z`)

/**
 * The two flights that exposed the split, kept as fixtures rather than prose.
 *
 * Both were drawn "~ In air" by the map while the board and the live feed said otherwise, from
 * opposite inputs — one arrived early against its projection, the other late. A rule that gets
 * only one of them right is the rule we already had.
 */
const FYC492: StatusFacts = {              // SAW→ALP, landed at 76% of its projected block
  status: 'Arrived',
  actual_dep_utc: '2026-08-14T01:44:40Z',
  actual_arr_utc: '2026-08-14T02:59:11Z',
  duration_min: 105,
}
const RJA431: StatusFacts = {              // AMM→ALP, projection complete, arrival not yet published
  status: 'Departed',
  actual_dep_utc: '2026-08-14T01:45:47Z',
  actual_arr_utc: null,
  revised_arr_utc: '2026-08-14T02:38:38Z',
  duration_min: 85,
}

test('an actual arrival ends the flight, however far along the projection is', () => {
  // 03:04 — the moment the map still said "~ In air". 76% of the block had elapsed.
  assert.equal(hasArrived(FYC492, T('03:04')), true)
  assert.equal(effectiveStatus(FYC492, T('03:04')), 'Arrived')
})

test('a completed projection alone does not claim an arrival too early', () => {
  // Its revised arrival passed at 02:38, but it did not land until 02:57. The old map rule
  // reached 1.0 at 02:38 and would have been nineteen minutes early had it also confirmed.
  assert.equal(hasArrived(RJA431, T('02:45')), false, 'not arrived just because the estimate passed')
  assert.equal(effectiveStatus(RJA431, T('02:45')), 'Departed')
})

test('an unconfirmed flight is called arrived once the block plus grace has elapsed', () => {
  // dep 01:45:47 + 85m = 03:10:47, + 15m grace = 03:25:47. Never earlier.
  assert.equal(hasArrived(RJA431, T('03:20')), false)
  assert.equal(hasArrived(RJA431, T('03:30')), true, 'so it cannot sit airborne for three hours')
})

test('the arrival, once published, wins over the grace clock', () => {
  const withArrival = { ...RJA431, actual_arr_utc: '2026-08-14T02:57:18Z' }
  assert.equal(hasArrived(withArrival, T('02:58')), true, 'a minute after FR24 published it')
})

test('Landed is spelled two ways and means the same thing', () => {
  for (const status of ['Landed', 'Land', 'Arrived']) {
    assert.equal(hasArrived({ status }, T('03:00')), true, status)
  }
})

test('cancelled and diverted are not arrivals, and outrank the grace clock', () => {
  const longGone = { actual_dep_utc: '2026-08-14T01:00:00Z', duration_min: 60 }
  assert.equal(hasArrived({ ...longGone, status: 'Cancelled' }, T('05:00')), false)
  assert.equal(hasArrived({ ...longGone, status: 'Diverted' }, T('05:00')), false)
  assert.equal(effectiveStatus({ ...longGone, status: 'Diverted' }, T('05:00')), 'Diverted')
})

test('a flight with no departure is never arrived', () => {
  assert.equal(hasArrived({ status: 'Scheduled', duration_min: 90 }, T('23:00')), false)
})

test('a revised arrival on a scheduled flight reads as Expected', () => {
  assert.equal(
    effectiveStatus({ status: 'Scheduled', revised_arr_utc: '2026-08-14T09:00:00Z' }, T('03:00')),
    'Expected')
})

test('a departed flight with an unknown status still reads as Departed', () => {
  assert.equal(
    effectiveStatus({ status: 'Unknown', actual_dep_utc: '2026-08-14T02:00:00Z' }, T('03:00')),
    'Departed')
})

/** Instance ranking — which copy of a daily rotation the map should draw. */
test('a flight that landed minutes ago outranks tomorrow’s empty copy', () => {
  // ABY433 on 14 Aug: landed 03:02:55, while the 15 Aug row had no times, no registration.
  const today    = { actual_dep_utc: '2026-08-14T00:23:27Z', actual_arr_utc: '2026-08-14T03:02:55Z' }
  const tomorrow = { actual_dep_utc: null, actual_arr_utc: null }
  assert.ok(rankInstance(today, T('03:13')) > rankInstance(tomorrow, T('03:13')),
    'the flight that actually operated must win')
})

test('an airborne flight outranks everything — the FZ1192 case', () => {
  const airborne = { actual_dep_utc: '2026-08-14T01:00:00Z', actual_arr_utc: null }
  const landed   = { actual_dep_utc: '2026-08-14T00:00:00Z', actual_arr_utc: '2026-08-14T02:00:00Z' }
  const future   = { actual_dep_utc: null, actual_arr_utc: null }
  assert.ok(rankInstance(airborne, T('03:00')) > rankInstance(landed, T('03:00')))
  assert.ok(rankInstance(airborne, T('03:00')) > rankInstance(future,  T('03:00')))
})

test('an old arrival yields to tomorrow, because it is history', () => {
  const yesterday = { actual_dep_utc: '2026-08-13T20:00:00Z', actual_arr_utc: '2026-08-13T22:00:00Z' }
  const tomorrow  = { actual_dep_utc: null, actual_arr_utc: null }
  assert.ok(rankInstance(yesterday, T('12:00')) < rankInstance(tomorrow, T('12:00')))
})

/**
 * FAD742, 14 Aug — the stopwatch reaching a conclusion the position contradicts.
 *
 * DAM→JED, departed 08:21:04 on a 112-minute block, so the grace rule fires at 10:28:04. No
 * arrival was ever published. It was last seen at 10:00:25 descending through 12,575 ft, 45 km
 * from Jeddah, and the marker sat frozen there while the card flipped to Arrived and the flight
 * dropped out of the in-air panel.
 */
const FAD742: StatusFacts = {
  status: 'Departed',
  actual_dep_utc: '2026-08-14T08:21:04Z',
  actual_arr_utc: null,
  duration_min: 112,
}

test('a fresh airborne fix overrules the stopwatch', () => {
  // Same flight, seen airborne two minutes ago: still flying, whatever the block says.
  assert.equal(hasArrived({ ...FAD742, airborne_fix_age_s: 120 }, T('10:30')), false)
  assert.equal(effectiveStatus({ ...FAD742, airborne_fix_age_s: 120 }, T('10:30')), 'Departed')
})

test('a stale airborne fix does not, because it no longer describes now', () => {
  // The real case: last seen 30 minutes earlier on approach. By then it had almost certainly
  // landed, and the clock is the best thing left.
  assert.equal(hasArrived({ ...FAD742, airborne_fix_age_s: 1800 }, T('10:30')), true)
})

test('with no position at all the rule is unchanged', () => {
  assert.equal(hasArrived(FAD742, T('10:30')), true, 'callers with nothing to offer keep old behaviour')
  assert.equal(hasArrived(FAD742, T('10:20')), false, 'and the grace period still has to elapse')
})

test('a published arrival still wins over a fresh airborne fix', () => {
  // Contradictory inputs, but one of them is an observation of the landing itself.
  assert.equal(hasArrived({ ...FAD742, actual_arr_utc: '2026-08-14T10:07:00Z', airborne_fix_age_s: 60 }, T('10:30')), true)
})

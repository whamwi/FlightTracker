import test from 'node:test'
import assert from 'node:assert/strict'

import {
  statusBadge, phaseLabel, fixAgeSec, STALE_FIX_SEC, type PopupFlight,
} from './v3-popup.ts'

const NOW = Date.parse('2026-08-27T12:00:00Z')

const flight = (over: Partial<PopupFlight> = {}): PopupFlight => ({
  callsign: 'SYR444', iata_number: 'RB444', airline_iata: 'RB',
  dep_iata: 'IST', arr_iata: 'DAM', phase: 'en_route',
  eta_stable_utc: '2026-08-27T13:00:00Z', delay_min: 0,
  position: {
    altitude_ft: 34000, ground_speed_kts: 470, track_deg: 130,
    fix_at: '2026-08-27T11:59:30Z', pos_source: 'observed',
  },
  ...over,
})

test('the badge speaks the server phase, not a reconstruction of it', () => {
  /*
   * V2 worked the status out for itself from timestamps and the predictor's state, which is how
   * ABY433 read "signal lost" under a marker labelled ARRIVED on 14 Aug. Here the word and the
   * position are the same answer read twice.
   */
  assert.equal(statusBadge(flight({ phase: 'landed' }), NOW, 'en').label, 'Landed')
  assert.equal(statusBadge(flight({ phase: 'taxi_to_gate' }), NOW, 'en').label, 'Taxi to gate')
})

test('a projected position is marked with a tilde', () => {
  // V2's convention, kept so moving between the two maps does not mean learning a second one.
  const f = flight({ position: { ...flight().position!, pos_source: 'projected' } })
  assert.ok(statusBadge(f, NOW, 'en').label.startsWith('~ '))
})

test('a stale fix is called out rather than shown as current', () => {
  const f = flight({ position: { ...flight().position!, fix_at: '2026-08-27T11:55:00Z' } })  // 5 min
  const b = statusBadge(f, NOW, 'en')
  assert.match(b.label, /Signal Lost|Signal lost/i)
  assert.equal(b.bg, '#7f1d1d')
})

test('a fresh fix is not', () => {
  assert.equal(statusBadge(flight(), NOW, 'en').bg, '#166534')
})

test('an unmeasurable fix age is null, never zero', () => {
  /*
   * A fix with no timestamp is not a fresh fix — it is one whose age cannot be measured. Calling
   * that zero is how a stale marker gets drawn as live, which is the same "presence is not
   * usability" fault as reading `pos is None` and calling any fix at all evidence of flight.
   */
  assert.equal(fixAgeSec(flight({ position: { ...flight().position!, fix_at: null } }), NOW), null)
  assert.equal(fixAgeSec(flight({ position: null }), NOW), null)
  assert.equal(fixAgeSec(flight({ position: { ...flight().position!, fix_at: 'not a date' } }), NOW), null)
  // And an unmeasurable age must not be reported as stale.
  assert.equal(statusBadge(flight({ position: { ...flight().position!, fix_at: null } }), NOW, 'en').bg, '#166534')
})

test('the stale threshold is two fixes, not one', () => {
  // An individual aircraft's fix arrives roughly every 55s. Missing one is normal; missing two
  // in a row means it has genuinely gone quiet.
  assert.equal(STALE_FIX_SEC, 120)
  const justUnder = flight({
    position: { ...flight().position!, fix_at: new Date(NOW - (STALE_FIX_SEC - 5) * 1000).toISOString() },
  })
  assert.equal(statusBadge(justUnder, NOW, 'en').bg, '#166534')
})

test('an unknown phase still says something', () => {
  // The server can introduce a phase before the client knows it — that is deliberate, so a new
  // state ships without a client deploy. It must degrade to a word, not to the raw key.
  const label = phaseLabel('some_future_phase', 'en')
  assert.ok(label && !label.includes('phase.'), label)
})

test('Arabic is served from the same vocabulary', () => {
  const ar = phaseLabel('landed', 'ar')
  assert.notEqual(ar, 'Landed')
  assert.ok(ar.length > 0)
})




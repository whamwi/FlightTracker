import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildV3Popup, statusBadge, phaseLabel, fixAgeSec, STALE_FIX_SEC, type PopupFlight,
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
  const [label] = statusBadge(flight({ phase: 'landed' }), NOW, 'en')
  assert.equal(label, 'Landed')
  assert.equal(statusBadge(flight({ phase: 'taxi_to_gate' }), NOW, 'en')[0], 'Taxi to gate')
})

test('a projected position is marked with a tilde', () => {
  // V2's convention, kept so moving between the two maps does not mean learning a second one.
  const f = flight({ position: { ...flight().position!, pos_source: 'projected' } })
  assert.ok(statusBadge(f, NOW, 'en')[0].startsWith('~ '))
})

test('a stale fix is called out rather than shown as current', () => {
  const f = flight({ position: { ...flight().position!, fix_at: '2026-08-27T11:55:00Z' } })  // 5 min
  const [label, bg] = statusBadge(f, NOW, 'en')
  assert.match(label, /Signal Lost|Signal lost/i)
  assert.equal(bg, '#7f1d1d')
})

test('a fresh fix is not', () => {
  const [, bg] = statusBadge(flight(), NOW, 'en')
  assert.equal(bg, '#166534')
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
  const [, bg] = statusBadge(flight({ position: { ...flight().position!, fix_at: null } }), NOW, 'en')
  assert.equal(bg, '#166534')
})

test('the stale threshold is two fixes, not one', () => {
  // An individual aircraft's fix arrives roughly every 55s. Missing one is normal; missing two
  // in a row means it has genuinely gone quiet.
  assert.equal(STALE_FIX_SEC, 120)
  const justUnder = flight({
    position: { ...flight().position!, fix_at: new Date(NOW - (STALE_FIX_SEC - 5) * 1000).toISOString() },
  })
  assert.equal(statusBadge(justUnder, NOW, 'en')[1], '#166534')
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

test('the popup renders the flight without throwing on missing pieces', () => {
  const bare: PopupFlight = {
    callsign: null, iata_number: null, dep_iata: null, arr_iata: null,
    phase: 'en_route', position: null,
  }
  const html = buildV3Popup(bare, NOW, 'en')
  assert.ok(html.includes('<div'), 'still renders')
})

test('anything that reaches the page is escaped', () => {
  /*
   * The document is upstream data. A callsign is not markup, and building HTML by concatenation
   * without escaping is how a feed becomes an injection.
   */
  const html = buildV3Popup(flight({ iata_number: '<img src=x onerror=alert(1)>' }), NOW, 'en')
  assert.ok(!html.includes('<img src=x'), 'raw tag must not survive')
  assert.ok(html.includes('&lt;img'), 'it should be escaped instead')
})

test('a delay is signed and coloured, and zero says nothing', () => {
  assert.ok(buildV3Popup(flight({ delay_min: 25 }), NOW, 'en').includes('+25m'))
  assert.ok(buildV3Popup(flight({ delay_min: -10 }), NOW, 'en').includes('-10m'))
  const onTime = buildV3Popup(flight({ delay_min: 0 }), NOW, 'en')
  assert.ok(!onTime.includes('0m</span>'), 'on time is not worth a line')
})

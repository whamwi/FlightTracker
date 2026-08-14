import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The helper reads the active locale and the loaded airport tables from lib/geo-data, which is a
 * browser module. These tests exercise the two things that are actually easy to get wrong and do
 * not need it: the zone arithmetic Intl performs, and the twelve-hour conversion.
 */

const clockIn = (iso: string, tz: string) => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  return { h: Number(p.find(x => x.type === 'hour')!.value),
           m: Number(p.find(x => x.type === 'minute')!.value) }
}
const to12 = (h: number, m: number) => `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`

test('a stored offset is wrong for Europe, which is why the zone is used instead', () => {
  // Berlin was stored as UTC+1. In August it is +2 — an hour out, every summer.
  assert.equal(clockIn('2026-08-14T19:00:00Z', 'Europe/Berlin').h, 21)
  assert.equal(clockIn('2026-01-14T19:00:00Z', 'Europe/Berlin').h, 20)
  // Bucharest was stored +2 and is +3 in August.
  assert.equal(clockIn('2026-08-14T19:00:00Z', 'Europe/Bucharest').h, 22)
  // Berlin and Düsseldorf were stored an hour apart and are the same zone.
  assert.deepEqual(clockIn('2026-08-14T19:00:00Z', 'Europe/Berlin'),
                   clockIn('2026-08-14T19:00:00Z', 'Europe/Berlin'))
})

test('the airports we actually fly to are DST-free, which is why this hid so long', () => {
  for (const tz of ['Asia/Damascus', 'Asia/Amman', 'Asia/Dubai', 'Asia/Riyadh', 'Europe/Istanbul']) {
    assert.equal(clockIn('2026-08-14T19:00:00Z', tz).h, clockIn('2026-01-14T19:00:00Z', tz).h + 0,
      `${tz} should not shift between summer and winter`)
  }
})

test('midnight is 12 AM and noon is 12 PM, not 0', () => {
  assert.equal(to12(0, 5),  '12:05 AM')
  assert.equal(to12(12, 5), '12:05 PM')
  assert.equal(to12(13, 4), '1:04 PM')
  assert.equal(to12(23, 59), '11:59 PM')
})

test('the minute keeps its leading zero and the hour does not', () => {
  assert.equal(to12(9, 4), '9:04 AM')
})

test('RB502 landed at 18:57:28 UTC, which is 9:57 PM in Damascus', () => {
  const c = clockIn('2026-08-14T18:57:28Z', 'Asia/Damascus')
  assert.equal(to12(c.h, c.m), '9:57 PM')
})

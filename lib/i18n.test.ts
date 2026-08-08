import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translate, isLocale, dirOf, ALL_KEYS, LOCALES, DEFAULT_LOCALE } from './i18n.ts'

test('every English key has an Arabic translation', () => {
  const missing = ALL_KEYS.filter(k => translate('ar', k) === k)
  assert.deepEqual(missing, [], `untranslated: ${missing.join(', ')}`)
})

test('a missing key returns itself, so the gap is visible on the page', () => {
  assert.equal(translate('ar', 'nope.not.a.key'), 'nope.not.a.key')
})

test('direction follows the locale', () => {
  assert.equal(dirOf('ar'), 'rtl')
  assert.equal(dirOf('en'), 'ltr')
})

test('isLocale rejects anything not in the list', () => {
  assert.equal(isLocale('ar'), true)
  assert.equal(isLocale('en'), true)
  assert.equal(isLocale('fr'), false)
  assert.equal(isLocale(null), false)
  assert.equal(isLocale(''), false)
  // A path segment that merely starts with a locale must not pass.
  assert.equal(isLocale('arabic'), false)
})

/*
 * Numbers stay Western Arabic everywhere, including inside Arabic sentences. A departure
 * board reading ١٠:١٥ is harder to scan than 10:15 for exactly the readers it is meant for,
 * and every time on this site comes from the data rather than the dictionary — so the only
 * place Arabic-Indic digits could creep in is a translated string.
 */
test('no Arabic-Indic digits in any translation', () => {
  const offenders = ALL_KEYS
    .flatMap(k => LOCALES.map(l => ({ k, l, v: translate(l, k) })))
    .filter(({ v }) => /[٠-٩۰-۹]/.test(v))
    .map(({ k, l }) => `${l}:${k}`)
  assert.deepEqual(offenders, [], `Arabic-Indic digits in: ${offenders.join(', ')}`)
})

test('English is the unprefixed default', () => {
  assert.equal(DEFAULT_LOCALE, 'en')
})

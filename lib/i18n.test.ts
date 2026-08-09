import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translate, isLocale, dirOf, ALL_KEYS, LOCALES, DEFAULT_LOCALE, counted, countNumber, pluralCategory, alternatesFor } from './i18n.ts'

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

test('Arabic counted nouns take the form the number requires', () => {
  // The whole point of the helper: 10 and 22 disagree, and both are right.
  assert.equal(counted('ar', 1,  'noun.dest'), '1 وجهة')
  // The dual is marked on the noun, so the numeral would say it twice.
  assert.equal(counted('ar', 2,  'noun.dest'), 'وجهتان')
  assert.equal(counted('ar', 10, 'noun.dest'), '10 وجهات')
  assert.equal(counted('ar', 22, 'noun.dest'), '22 وجهة')
  assert.equal(counted('ar', 0,  'noun.dest'), '0 وجهات')
  // 103 % 100 = 3, which is the plural band again — the modulo is not decoration.
  assert.equal(counted('ar', 103, 'noun.flight'), '103 رحلات')
  assert.equal(counted('ar', 100, 'noun.flight'), '100 رحلة')
})

test('English splits at one and nowhere else', () => {
  assert.equal(counted('en', 1,  'noun.route'), '1 route')
  assert.equal(counted('en', 2,  'noun.route'), '2 routes')
  assert.equal(counted('en', 0,  'noun.route'), '0 routes')
  assert.equal(counted('en', 22, 'noun.route'), '22 routes')
})

test('every Arabic plural category is filled for every counted noun', () => {
  const cats = ['zero', 'one', 'two', 'few', 'many', 'other']
  const missing: string[] = []
  for (const base of ['noun.dest', 'noun.airline', 'noun.flight', 'noun.route']) {
    for (const c of cats) {
      const k = `${base}.${c}`
      if (translate('ar', k) === k) missing.push(k)
    }
  }
  assert.deepEqual(missing, [], `unfilled: ${missing.join(', ')}`)
})

test('a number never lands on a category the dictionary cannot answer', () => {
  for (let n = 0; n <= 250; n++) {
    const cat = pluralCategory('ar', n)
    const k = `noun.flight.${cat}`
    assert.notEqual(translate('ar', k), k, `n=${n} → ${cat}`)
  }
})

test('only the Arabic dual drops its numeral', () => {
  assert.equal(countNumber('ar', 2),   '')
  assert.equal(countNumber('ar', 102), '102')  // CLDR two is n === 2, not n % 100 === 2
  assert.equal(countNumber('ar', 1),   '1')
  assert.equal(countNumber('ar', 12),  '12')
  assert.equal(countNumber('en', 2),   '2')
})

test('each language canonicalises to itself, never to the other', () => {
  // The bug this replaces: /ar pointing at /, which tells Google to drop the Arabic page.
  const ar = alternatesFor('/ar/flight/XH728')
  assert.equal(ar.canonical, 'https://www.flysyria.app/ar/flight/XH728')
  const en = alternatesFor('/flight/XH728')
  assert.equal(en.canonical, 'https://www.flysyria.app/flight/XH728')
})

test('the hreflang pair is the same on both sides of it', () => {
  const a = alternatesFor('/ar/board').languages
  const b = alternatesFor('/board').languages
  assert.deepEqual(a, b)
  assert.equal(a.en, 'https://www.flysyria.app/board')
  assert.equal(a.ar, 'https://www.flysyria.app/ar/board')
  assert.equal(a['x-default'], a.en)
})

test('the roots do not collapse to a trailing slash or a doubled one', () => {
  assert.equal(alternatesFor('/').canonical,   'https://www.flysyria.app')
  assert.equal(alternatesFor('/ar').canonical, 'https://www.flysyria.app/ar')
  // /en is a root alias for /, so it must claim the English root rather than itself.
  assert.equal(alternatesFor('/en').canonical, 'https://www.flysyria.app')
})

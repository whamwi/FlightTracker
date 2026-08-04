/**
 * Unit tests for photo caching decisions.
 *
 * Run with:  node --experimental-strip-types --test lib/aircraft-photo.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { isFresh, toClientUrl, HIT_TTL_MS, MISS_TTL_MS } from './aircraft-photo.ts'

const NOW = 1_700_000_000_000
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('cache freshness', () => {
  test('a found photo is kept for a long time', () => {
    assert.equal(isFresh({ url: 'x', resolved_at: ago(HIT_TTL_MS - 1000) }, NOW), true)
    assert.equal(isFresh({ url: 'x', resolved_at: ago(HIT_TTL_MS + 1000) }, NOW), false)
  })

  // An aircraft with no photo anywhere would otherwise cost two upstream calls on every
  // single view — the worst case rather than the rare one — so misses are cached as well.
  test('a miss is cached, but retried far sooner', () => {
    assert.equal(isFresh({ url: null, resolved_at: ago(MISS_TTL_MS - 1000) }, NOW), true)
    assert.equal(isFresh({ url: null, resolved_at: ago(MISS_TTL_MS + 1000) }, NOW), false)
    assert.ok(MISS_TTL_MS < HIT_TTL_MS)
  })

  test('an unparseable timestamp is treated as stale rather than trusted', () => {
    assert.equal(isFresh({ url: 'x', resolved_at: 'not a date' }, NOW), false)
  })
})

describe('stored rows are origin-independent', () => {
  // JetPhotos needs the proxy to defeat hotlink protection, but that URL carries the
  // request's origin — so the row stores the upstream address and the proxy is applied on
  // the way out, letting the same row serve any host.
  test('a JetPhotos row is proxied through the requesting origin', () => {
    const url = toClientUrl(
      { url: 'https://cdn.jetphotos.com/full/1/x.jpg', needs_proxy: true },
      'https://www.flysyria.app',
    )
    assert.equal(url, 'https://www.flysyria.app/api/photo-img?u=https%3A%2F%2Fcdn.jetphotos.com%2Ffull%2F1%2Fx.jpg')
  })

  test('the same row serves a different origin unchanged', () => {
    const row = { url: 'https://cdn.jetphotos.com/full/1/x.jpg', needs_proxy: true }
    assert.ok(toClientUrl(row, 'https://preview.example.com')!.startsWith('https://preview.example.com/'))
  })

  test('Planespotters is served directly', () => {
    const url = 'https://t.plnspttrs.net/1/x_tb.jpg'
    assert.equal(toClientUrl({ url, needs_proxy: false }, 'https://www.flysyria.app'), url)
  })

  test('a cached miss yields no url', () => {
    assert.equal(toClientUrl({ url: null, needs_proxy: false }, 'https://www.flysyria.app'), null)
  })
})

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAP_VARIANTS, DEFAULT_VARIANT, isVariant, storedVariant, storeVariant,
} from './map-variant.ts'

/** localStorage does not exist under node:test, so each case supplies the behaviour it needs. */
function withStorage(impl: Partial<Storage> | null, fn: () => void) {
  const g = globalThis as { localStorage?: unknown }
  const had = 'localStorage' in g
  const prev = g.localStorage
  if (impl) g.localStorage = impl
  else delete g.localStorage
  try { fn() } finally {
    if (had) g.localStorage = prev
    else delete g.localStorage
  }
}

const store = (initial: Record<string, string> = {}) => {
  const m = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    _map: m,
  } as unknown as Partial<Storage> & { _map: Map<string, string> }
}

test('the default is the map that already works', () => {
  // A rewrite is not the default on the day it is written. V3 earns it by being watched against
  // V2 on the arrivals V2 gets wrong.
  assert.equal(DEFAULT_VARIANT, 'v2')
  assert.ok(MAP_VARIANTS.includes(DEFAULT_VARIANT))
})

test('a stored choice is honoured', () => {
  withStorage(store({ 'flysyria:map-variant': 'v3' }), () => {
    assert.equal(storedVariant(), 'v3')
  })
})

test('an unrecognised stored value falls back rather than breaking', () => {
  /*
   * Not hypothetical. The app's own variant store had to survive a stored 'v1' after v1 was
   * removed — someone who had chosen it would otherwise have been left on a name nothing renders.
   */
  withStorage(store({ 'flysyria:map-variant': 'v1' }), () => {
    assert.equal(storedVariant(), DEFAULT_VARIANT)
  })
  withStorage(store({ 'flysyria:map-variant': '' }), () => {
    assert.equal(storedVariant(), DEFAULT_VARIANT)
  })
})

test('no storage at all is the default, not a crash', () => {
  // Private mode, or a browser with site data blocked. The map must still render.
  withStorage(null, () => {
    assert.equal(storedVariant(), DEFAULT_VARIANT)
  })
})

test('storage that throws on read is survived', () => {
  const hostile = { getItem() { throw new Error('blocked') }, setItem() {} }
  withStorage(hostile as unknown as Partial<Storage>, () => {
    assert.equal(storedVariant(), DEFAULT_VARIANT)
  })
})

test('storage that throws on write does not take the page with it', () => {
  const hostile = { getItem: () => null, setItem() { throw new Error('quota') } }
  withStorage(hostile as unknown as Partial<Storage>, () => {
    assert.doesNotThrow(() => storeVariant('v3'))
  })
})

test('a choice round-trips', () => {
  const s = store()
  withStorage(s, () => {
    storeVariant('v3')
    assert.equal(storedVariant(), 'v3')
    storeVariant('v2')
    assert.equal(storedVariant(), 'v2')
  })
})

test('isVariant rejects everything that is not one', () => {
  assert.ok(isVariant('v2') && isVariant('v3'))
  for (const bad of ['v1', 'V3', '', 'v3 ', null, undefined, 3, {}]) {
    assert.equal(isVariant(bad), false, String(bad))
  }
})

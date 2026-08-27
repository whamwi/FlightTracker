import test from 'node:test'
import assert from 'node:assert/strict'

import { isInSyria, overflightsInSyria, type Overflight } from './overflight.ts'

/**
 * A square standing in for Syria: 33-36 N, 36-42 E. Roughly the real bounding box, which is all
 * these cases need — the polygon walk is what is under test, not the border itself.
 */
const BOX = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[[36, 33], [42, 33], [42, 36], [36, 36], [36, 33]]],
    },
  }],
}

const DAMASCUS: [number, number] = [33.51, 36.29]   // inside
const BEIRUT:   [number, number] = [33.82, 35.49]   // just west, outside
const CYPRUS:   [number, number] = [35.10, 33.30]   // well outside

const ac = (over: Partial<Overflight> = {}): Overflight => ({
  flight: 'UAE201', lat: 34.5, lon: 38.0, track: 90, alt_baro: 36000, gs: 480,
  t: 'B77W', r: 'A6-EGA', board_match: null,
  ...over,
})

test('a point inside the polygon is inside', () => {
  assert.equal(isInSyria(DAMASCUS[0], DAMASCUS[1], BOX), true)
})

test('a point outside it is not', () => {
  assert.equal(isInSyria(BEIRUT[0], BEIRUT[1], BOX), false)
  assert.equal(isInSyria(CYPRUS[0], CYPRUS[1], BOX), false)
})

test('no polygon means no, not yes', () => {
  /*
   * The fence is fetched once and the first poll can beat it. Answering "inside" while it loads
   * would flash every aircraft in the feed — Cyprus to Tehran — onto the map for a second. This
   * is the same fault as `pos is None`: treating an unanswerable question as a yes.
   */
  assert.equal(isInSyria(DAMASCUS[0], DAMASCUS[1], null), false)
  assert.equal(isInSyria(DAMASCUS[0], DAMASCUS[1], undefined), false)
  assert.deepEqual(overflightsInSyria([ac()], null), [])
})

test('a MultiPolygon is walked, not skipped', () => {
  // Today's syria_adm0.geojson is a single Polygon, but it is regenerated from upstream borders
  // and a MultiPolygon is what you get the moment the export includes an island or an enclave.
  const multi = {
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: [BOX.features[0].geometry.coordinates] },
  }
  assert.equal(isInSyria(DAMASCUS[0], DAMASCUS[1], multi), true)
  assert.equal(isInSyria(CYPRUS[0], CYPRUS[1], multi), false)
})

test('all three GeoJSON shapes are accepted', () => {
  /*
   * FeatureCollection is what ships today. The other two are valid GeoJSON for the same border and
   * cost one unwrap to support; a bare Feature previously fell through every branch and returned
   * false for every position, which is a blank layer rather than an error.
   */
  const geom = BOX.features[0].geometry
  const feature = { type: 'Feature', properties: {}, geometry: geom }
  for (const [name, shape] of [['collection', BOX], ['feature', feature], ['geometry', geom]] as const) {
    assert.equal(isInSyria(DAMASCUS[0], DAMASCUS[1], shape), true, `${name} inside`)
    assert.equal(isInSyria(CYPRUS[0], CYPRUS[1], shape), false, `${name} outside`)
  }
})

test('an aircraft already on the board is not drawn twice', () => {
  /*
   * board_match is the feed saying "this is a flight the map already has". Drawing it here puts a
   * second, differently-styled marker on top of the first.
   */
  assert.deepEqual(overflightsInSyria([ac({ board_match: 'SYR444' })], BOX), [])
  assert.deepEqual(overflightsInSyria([ac({ board_match: true })], BOX), [])
  assert.equal(overflightsInSyria([ac({ board_match: null })], BOX).length, 1)
  assert.equal(overflightsInSyria([ac({ board_match: false })], BOX).length, 1)
})

test('an aircraft with no callsign is dropped', () => {
  // The callsign is the marker's key. Without one there is nothing to add or remove it by, so it
  // would be re-created every poll and never cleaned up.
  assert.deepEqual(overflightsInSyria([ac({ flight: null })], BOX), [])
  assert.deepEqual(overflightsInSyria([ac({ flight: '' })], BOX), [])
  assert.deepEqual(overflightsInSyria([ac({ flight: '   ' })], BOX), [])
})

test('a missing or non-numeric position is dropped, never defaulted', () => {
  /*
   * 0,0 is in the Atlantic. Coercing a null position to zero puts an aircraft in the Gulf of
   * Guinea; here it is simply not drawn.
   */
  const bad = [
    ac({ lat: undefined as unknown as number }),
    ac({ lon: null as unknown as number }),
    ac({ lat: '34.5' as unknown as number }),
    ac({ lat: NaN }),
    ac({ lon: Infinity }),
  ]
  assert.deepEqual(overflightsInSyria(bad, BOX), [])
})

test('an empty or absent feed is empty, not a crash', () => {
  assert.deepEqual(overflightsInSyria([], BOX), [])
  assert.deepEqual(overflightsInSyria(undefined as unknown as Overflight[], BOX), [])
})

test('an ordinary overflight survives every filter', () => {
  const [got] = overflightsInSyria([ac()], BOX)
  assert.equal(got.flight, 'UAE201')
})

test('"ground" is a legal altitude, and does not disqualify an aircraft', () => {
  // ADS-B reports alt_baro as the string "ground", not zero. Nothing here reads it as a number,
  // and an aircraft on the ground inside Syria is still a real observation.
  assert.equal(overflightsInSyria([ac({ alt_baro: 'ground' })], BOX).length, 1)
})

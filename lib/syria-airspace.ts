import { SYRIA_RING } from './syria-ring'

/**
 * Is this position inside Syria?
 *
 * /api/airspace used to decide with a bounding box, which takes in Beirut, Amman, parts of
 * Iraq and southern Turkey. The web map hid that by re-testing against the real polygon in the
 * browser, so nobody saw a Lebanese aircraft labelled as over Syria — but the payload still
 * carried every one of them to an audience that is ~72% mobile, and the mobile app has no
 * polygon to re-test with. Doing it here means the list is correct before it is sent, and both
 * clients can trust it.
 *
 * The ring is the same outline the map draws, taken from public/syria_adm0.geojson and rounded
 * to 3 decimals — about 100 m, far finer than any position report.
 */

const ring = SYRIA_RING

/** Cheap rejection before the ray cast; the box is the polygon's own extent, rounded out. */
const BOX = { latMin: 32.0, latMax: 37.7, lonMin: 35.3, lonMax: 42.7 }

export function inSyriaBox(lat: number, lon: number): boolean {
  return lat >= BOX.latMin && lat <= BOX.latMax
      && lon >= BOX.lonMin && lon <= BOX.lonMax
}

/**
 * Ray casting: count crossings of the ring by a ray heading east from the point. Odd means
 * inside. Syria is a single ring with no holes, so this needs no winding rules.
 */
export function inSyria(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  if (!inSyriaBox(lat, lon)) return false

  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    // Strictly one of the two endpoints above the ray, so a vertex exactly on it is counted
    // once rather than twice.
    if ((yi > lat) !== (yj > lat)) {
      const x = (xj - xi) * (lat - yi) / (yj - yi) + xi
      if (lon < x) inside = !inside
    }
  }
  return inside
}

/**
 * OVER SYRIA — which aircraft crossing Syrian airspace the map draws.
 *
 * Deliberately free of imports so it can be tested. Its sibling lib/overflight-popup renders
 * these, and pulls in the airline tables and the translator to do it; that chain reaches
 * lib/airport-time, whose `@/lib` alias node:test cannot resolve. Keeping the decision apart from
 * the drawing means the decision is the part under test, which is the right way round.
 */
/** The fields this layer reads from /api/airspace. */
export type Overflight = {
  hex?: string | null
  flight?: string | null
  lat: number
  lon: number
  track?: number | null
  /*
   * ADS-B reports this as the string "ground" for an aircraft on the surface, not as a number and
   * not as zero — which is why every read of it is guarded by `typeof === 'number'` rather than a
   * null check. Narrowing this to `number | null` type-checked here and failed at the call site.
   */
  alt_baro?: number | string | null
  gs?: number | null
  t?: string | null
  r?: string | null
  board_match?: unknown
}

// ── Geofence ────────────────────────────────────────────────────────────────
//
// Moved here from Map.tsx when V3 needed the same test. Point-in-polygon by ray casting: count
// the edges a ray crossing east from the point intersects; an odd count is inside.

function raycast(lat: number, lon: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (((yi > lat) !== (yj > lat)) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

/**
 * Is this position inside Syria?
 *
 * NO POLYGON MEANS NO, not yes. The GeoJSON is fetched once and the first polls can land before it
 * arrives; answering "inside" while the fence is still loading would flash every aircraft in the
 * feed — Cyprus to Tehran — onto the map for a second. Better to show nothing for one poll.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isInSyria(lat: number, lon: number, geo: any): boolean {
  if (!geo) return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const feat of (geo.features ?? [geo])) {
    // Unwrap as far as a geometry: a Feature holds one, a bare geometry is already it. Today's
    // syria_adm0.geojson is a FeatureCollection of one Polygon, but the file is regenerated from
    // upstream borders and any of the three shapes is valid GeoJSON for it.
    const g = feat?.geometry ?? feat
    if (!g?.type) continue
    if (g.type === 'Polygon'      && raycast(lat, lon, g.coordinates[0]))              return true
    if (g.type === 'MultiPolygon' && g.coordinates.some((p: number[][][]) => raycast(lat, lon, p[0]))) return true
  }
  return false
}

/**
 * Which aircraft this layer draws.
 *
 * One place, so the two maps cannot disagree about what an overflight is. A missing or
 * non-numeric position is dropped rather than defaulted — 0,0 is in the Atlantic.
 */
export function overflightsInSyria(
  aircraft: Overflight[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  syriaGeo: any,
): Overflight[] {
  const out: Overflight[] = []
  for (const a of aircraft ?? []) {
    if (a.board_match) continue
    if (!a.flight || !a.flight.trim()) continue
    if (typeof a.lat !== 'number' || typeof a.lon !== 'number') continue
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue
    if (!isInSyria(a.lat, a.lon, syriaGeo)) continue
    out.push(a)
  }
  return out
}

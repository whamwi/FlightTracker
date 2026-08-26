/**
 * The FlySyria basemap: OpenStreetMap data, OSMF's own vector tiles, styled here.
 *
 * ── Why this exists ──
 *
 * On 26 Aug 2026 CARTO began painting "API KEY REQUIRED" into a subset of the keyless raster
 * tiles this map had used for months. It is baked into the PNG, so nothing errors — tiles return
 * 200 with valid image data and the words are simply there, on some tiles and not others, which
 * is why it came and went with zoom and looked at first like it affected only one surface.
 *
 * A free CARTO key would remove it in one line. It was not the answer, because CARTO is retiring
 * its raster basemaps altogether and considering stopping data updates to them: the key buys a
 * working map with slowly staling cartography, and the same move again later.
 *
 * ── What changes, beyond the watermark ──
 *
 * Raster tiles are pictures. Whatever the renderer decided is baked in, and the only control is
 * which whole layer to switch on. These are GEOMETRY — coastlines, water, boundaries, place
 * points — and everything below is our decision, applied in the browser at draw time.
 *
 * That is what makes the map quiet enough for aircraft to sit on. There are no roads here, no
 * buildings, no landuse, no points of interest, because those layers are simply not drawn. The
 * old basemap carried all of them and the markers had to compete.
 *
 * We were always using OpenStreetMap — the attribution has read "OpenStreetMap contributors,
 * CARTO" since the beginning. What changed is who renders it, and that it is now us.
 */

/** OSMF's own vector tiles. No API key, no account, Shortbread schema. */
const SHORTBREAD = 'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt'

/**
 * English where OSM has it, the local name otherwise.
 *
 * Worth revisiting when the Arabic site lands: `name_ar` is present on most places in the region,
 * so an Arabic basemap is a one-line change here rather than a different tile source.
 */
const LABEL = ['coalesce', ['get', 'name_en'], ['get', 'name']]

/**
 * Place labels, thinned by POPULATION, with the bar falling as the map zooms in.
 *
 * Filtering on `kind` alone draws every OSM "city", which over Turkey means Konya, Kayseri, Sivas,
 * Çorum, Elazığ and dozens more crowding the opening view. Shortbread ships `population` on every
 * place, so size decides instead of category.
 *
 * National capitals are exempt at every zoom — Nicosia and Valletta are small and are the whole
 * point of their island.
 *
 * ── Why four layers instead of one interpolate ──
 *
 * The obvious version puts an ['interpolate', ['zoom'], …] threshold inside the filter, and it
 * SILENTLY DOES NOT WORK: MapLibre permits zoom expressions only in layout and paint properties,
 * never in `filter`. Nothing throws. The comparison never becomes true, so capitals keep drawing
 * off the other branch while every city disappears at every zoom — a map that reads as
 * deliberately minimal rather than broken, which is the dangerous kind of wrong.
 *
 * So the zoom-dependence lives where it is allowed: each layer's own minzoom/maxzoom, with a fixed
 * bar inside. GL draws a layer for minzoom <= z < maxzoom, so these ranges tile the zoom axis
 * without overlap and no label is ever drawn twice.
 *
 * These are MapLibre's zoom numbers, one BELOW what Leaflet's zoom control reads — the GL layer
 * runs 512px tiles against Leaflet's 256.
 */
const PLACE_STEPS: [number, number, number][] = [
  // [minzoom, maxzoom, minimum population]
  [0, 5, 3_000_000],   // opening view: the giants only
  [5, 7, 1_000_000],
  [7, 9, 250_000],
  [9, 24, 30_000],
]

const placeLayers = () => PLACE_STEPS.map(([minzoom, maxzoom, minPop]) => ({
  id: `places-${minzoom}`,
  type: 'symbol' as const,
  source: 'osm',
  'source-layer': 'place_labels',
  minzoom,
  maxzoom,
  filter: ['any',
    ['==', ['get', 'kind'], 'capital'],
    ['all',
      ['in', ['get', 'kind'], ['literal', ['city', 'town']]],
      ['>=', ['get', 'population'], minPop],
    ],
  ],
  layout: {
    'text-field': LABEL,
    'text-font': ['noto_sans_regular'],
    'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 9, 13],
    // Let GL drop a label rather than overlap one, and break ties by size, so the bigger place
    // survives a collision. The old raster basemap had no such arbitration.
    'text-padding': 6,
    'symbol-sort-key': ['-', 0, ['get', 'population']],
  },
  paint: {
    'text-color': '#5b6660',
    'text-halo-color': '#f4f5f0',
    'text-halo-width': 1.2,
  },
}))

export const BASEMAP_STYLE = {
  version: 8 as const,
  /*
   * Glyphs come from VersaTiles, and it is the one third-party dependency here.
   *
   * Rendering a label needs a font atlas and OSMF publishes none. VersaTiles serves fonts rather
   * than map content, so an outage costs labels, not the map. Self-hosting the atlas is a known,
   * small job if that trade stops being acceptable.
   */
  glyphs: 'https://tiles.versatiles.org/assets/glyphs/{fontstack}/{range}.pbf',
  sources: {
    osm: {
      type: 'vector' as const,
      tiles: [SHORTBREAD],
      maxzoom: 14,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    // Land is the background and water is painted over it. Shortbread separates ocean from inland
    // water, and BOTH must be drawn or the Gulf reads as desert.
    { id: 'bg', type: 'background' as const, paint: { 'background-color': '#f4f5f0' } },
    { id: 'ocean', type: 'fill' as const, source: 'osm', 'source-layer': 'ocean',
      paint: { 'fill-color': '#dde6e8' } },

    /*
     * INLAND WATER FROM ZOOM 7, and the minzoom is the whole reason this map renders at all.
     *
     * Without it, water_polygons is drawn at every zoom — and at the opening view that is every
     * lake, reservoir and wide river across a continent: 4084 features building a single bucket of
     * 96,370 vertices against MapLibre's hard limit of 65,535 per segment. The overflow does not
     * throw and does not fire an error event. It takes down the ENTIRE render pass: no coastlines,
     * no borders, no labels, nothing but the background colour, on a map whose style validates
     * clean, whose tiles load and parse, whose canvas is correctly sized and visible, and whose
     * queryRenderedFeatures cheerfully reports thousands of features being drawn.
     *
     * That combination shipped to production and had to be rolled back. The only outward sign was
     * a console WARNING — "Max vertices per segment is 65535: bucket requested 96370" — which
     * reads like a note about quality, not a total failure. It was found by hiding one layer at a
     * time in a live map until the other seven appeared.
     *
     * Zoom 7 because the ocean layer already carries every sea that matters at this scale — the
     * Mediterranean, the Black Sea, the Caspian and the Gulf are all in `ocean`. Inland water is
     * detail for when someone has zoomed into a country, and by then a tile covers little enough
     * ground that the bucket stays small.
     */
    { id: 'water', type: 'fill' as const, source: 'osm', 'source-layer': 'water_polygons',
      minzoom: 7,
      paint: { 'fill-color': '#dde6e8' } },

    // National borders only. admin_level 2 is the country line; without the filter every
    // provincial boundary in Syria and Turkey is drawn too, which is the clutter being removed.
    { id: 'borders', type: 'line' as const, source: 'osm', 'source-layer': 'boundaries',
      filter: ['==', ['get', 'admin_level'], 2],
      paint: { 'line-color': '#c3cdbe', 'line-width': 1 } },

    ...placeLayers(),
  ],
}

/**
 * The raster basemap to fall back to when the vector one cannot run.
 *
 * NOT optional, and not a nicety. MapLibre needs WebGL, and 72% of this site's traffic is mobile
 * with a large share on older Android and in-app browsers. Where WebGL is missing, blocked, or
 * fails to initialise, the alternative to a fallback is a page with aircraft floating on blank
 * white — strictly worse than the watermark this change exists to remove.
 *
 * Esri's grey canvas rather than CARTO's: it is unwatermarked, needs no key, and is the closest
 * match to the vector style's palette, so the fallback looks like a slightly plainer version of
 * the real thing rather than a different map. Its labels and borders arrive as a separate
 * transparent layer — see BASEMAP_FALLBACK_LABELS.
 */
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas'

export const BASEMAP_FALLBACK = {
  // {z}/{y}/{x} — Esri orders the path row-then-column, the opposite of the XYZ convention.
  // Get it wrong and tiles still load; they are the wrong piece of the world, mirrored about the
  // diagonal, which reads as a projection bug rather than a typo.
  url: `${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
  // maxNativeZoom, not maxZoom: Esri has no tiles past z16, so without the distinction Leaflet
  // requests z17+ and gets nothing, blanking the map exactly when someone zooms in on an airport.
  options: { attribution: 'Tiles © Esri', maxNativeZoom: 16, maxZoom: 19 },
}

export const BASEMAP_FALLBACK_LABELS = {
  url: `${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
  options: { attribution: '', maxNativeZoom: 16, maxZoom: 19 },
}

/**
 * Whether this browser can run the vector basemap.
 *
 * Creating a real context rather than checking for the constructor: `window.WebGLRenderingContext`
 * exists on plenty of devices that then fail to give you a context — blocklisted drivers, GPU
 * process crashes, memory pressure. The only honest test is to ask for one.
 */
export function canRenderVector(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

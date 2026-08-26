/**
 * Putting a basemap under the map, and taking it off again.
 *
 * Extracted from components/Map.tsx when the basemap became switchable. It had grown to sixty
 * lines of guards sitting in the middle of the map's init effect, and none of them could run
 * twice — which is exactly what a switcher needs.
 *
 * Every guard here is one that was earned. See lib/basemap-style for why we render OSM ourselves.
 */

import {
  BASEMAP_STYLE, BASEMAP_FALLBACK, BASEMAP_FALLBACK_LABELS, PLACE_LAYER_IDS, canRenderVector,
} from './basemap-style'

/** `vector` is ours, styled in the browser. `grey` is Esri's raster canvas — also the fallback. */
export type BasemapKind = 'vector' | 'grey'

export const BASEMAP_KINDS: BasemapKind[] = ['vector', 'grey']

const STORE_KEY = 'flysyria:basemap'

/** The reader's last choice, or the vector map. Storage can throw in private mode. */
export function storedBasemap(): BasemapKind {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return v === 'grey' || v === 'vector' ? v : 'vector'
  } catch { return 'vector' }
}

export function storeBasemap(kind: BasemapKind): void {
  try { localStorage.setItem(STORE_KEY, kind) } catch { /* private mode; the choice is per-visit */ }
}

const CITIES_KEY = 'flysyria:basemap-cities'

/** City labels on unless the reader turned them off. Only 'off' is stored as a decision. */
export function storedCities(): boolean {
  try { return localStorage.getItem(CITIES_KEY) !== 'off' } catch { return true }
}

export function storeCities(on: boolean): void {
  try { localStorage.setItem(CITIES_KEY, on ? 'on' : 'off') } catch { /* per-visit, then */ }
}

/** What attachBasemap hands back. */
export type BasemapHandle = {
  /** Take this basemap off the map, whatever it actually ended up being. */
  remove(): void
  /**
   * Show or hide the city labels. Only the vector map can do this — its labels are a layer we
   * own, so they come off while borders and coastlines stay. Esri bakes cities and borders into
   * one raster tile, so there this is a no-op and the UI disables the control.
   */
  setCities(on: boolean): void
}

export type BasemapOpts = {
  /** Start with city labels shown. Ignored on raster, which cannot honour it either way. */
  cities?: boolean
  /**
   * Called if the vector map could not be used and raster was substituted.
   *
   * The UI needs this: a reader who asked for the vector map and silently got raster would
   * otherwise be left with an enabled Cities control that does nothing.
   */
  onFallback?: () => void
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Add `kind` to `map`, and return a handle that removes whatever it ended up adding.
 *
 * "Whatever it ended up adding" is the important part: a request for `vector` can legitimately end
 * as raster, on a browser that cannot run WebGL or a load that fails. The handle tracks the layers
 * actually on the map rather than the ones that were asked for, so switching away always cleans up.
 */
export function attachBasemap(
  L: any, map: any, kind: BasemapKind, opts: BasemapOpts = {},
): BasemapHandle {
  const layers: any[] = []
  let cancelled = false
  let cities = opts.cities !== false
  // The live GL map, once there is one. Null on every raster path, which is what makes
  // setCities a no-op there rather than a crash.
  let gl: any = null

  /*
   * Applied on 'styledata' as well as immediately, because a layer cannot be addressed until the
   * style carrying it has loaded. Calling setLayoutProperty before that throws, and the first
   * call always arrives before it — the layer is created and the preference applied in the same
   * breath, long before MapLibre has parsed anything.
   */
  const applyCities = () => {
    if (!gl) return
    for (const id of PLACE_LAYER_IDS) {
      try { gl.setLayoutProperty(id, 'visibility', cities ? 'visible' : 'none') } catch { /* style not ready */ }
    }
  }

  const add = (layer: any) => {
    // A switch (or an unmount) can land while MapLibre is still downloading. Adding then would
    // put a basemap on the map that nothing is tracking, and it would never come off.
    if (cancelled) return
    layer.addTo(map)
    layers.push(layer)
  }

  const useRaster = (why: string) => {
    // Unconditional, including in production. Falling back is rare and always means something we
    // want to know about; one warn on an exceptional path is not noise.
    if (kind === 'vector') {
      console.warn(`[map] raster basemap: ${why}`)
      // Tell the caller the vector map is not what is on screen, so the Cities control can grey
      // itself out instead of pretending to work.
      opts.onFallback?.()
    }
    add(L.tileLayer(BASEMAP_FALLBACK.url, BASEMAP_FALLBACK.options))
    add(L.tileLayer(BASEMAP_FALLBACK_LABELS.url, BASEMAP_FALLBACK_LABELS.options))
  }

  if (kind === 'grey') {
    useRaster('chosen')
  } else if (!canRenderVector()) {
    /*
     * A real context, not a check for the constructor. `window.WebGLRenderingContext` exists on
     * plenty of devices that then refuse to give you a context — blocklisted drivers, a crashed
     * GPU process, memory pressure. The only honest test is to ask for one.
     */
    useRaster('no WebGL')
  } else {
    /*
     * Deliberately not awaited by the caller. The map's own setup — marker layers, overlays —
     * must not wait on a 230 KB download, so the basemap simply arrives when it arrives. Leaflet
     * keeps tile layers under everything else regardless of the order they were added, so a late
     * basemap lands beneath markers that are already on screen.
     */
    import('maplibre-gl')
      .then(async mod => {
        if (cancelled) return

        /*
         * BOTH globals before the plugin is imported, and this does not survive being guessed at.
         *
         * leaflet-maplibre-gl is a UMD bundle that reads `window.L` and `window.maplibregl` and
         * hangs `L.maplibreGL` off what it finds. A page loading Leaflet from a script tag gets
         * this for free; we import it as a module, so without these the plugin attaches to nothing.
         */
        const w = window as unknown as { L: unknown; maplibregl: unknown }
        w.maplibregl = (mod as any).default ?? mod
        w.L = L
        await import('maplibre-gl/dist/maplibre-gl.css')
        await import('@maplibre/maplibre-gl-leaflet')
        if (cancelled) return

        /*
         * Read the factory off the CJS exports object, NOT off `L`.
         *
         * Under a bundler the plugin takes its `typeof exports === 'object'` branch and assigns
         * onto `require('leaflet')`. Our `L` is the ES module namespace, whose named exports were
         * synthesised at evaluation — a property added afterwards never appears on it. So
         * `L.tileLayer` works and `L.maplibreGL` is permanently undefined.
         */
        const cjs = ((L as any).default ?? L) as any
        const maplibreGL = cjs.maplibreGL ?? (L as any).maplibreGL
        if (typeof maplibreGL !== 'function') throw new Error('plugin did not register')

        const el = map.getContainer()

        const attach = () => {
          if (cancelled) return

          /*
           * The Leaflet view must be VALID, not merely present. The plugin seeds the GL map with
           * the centre and zoom it reads from Leaflet at this moment, and a NaN centre yields a
           * map that reports no error, requests no tiles and paints only its background colour.
           */
          const c = map.getCenter()
          if (!Number.isFinite(c?.lat) || !Number.isFinite(c?.lng) || !Number.isFinite(map.getZoom())) {
            map.once('moveend zoomend', attach)
            return
          }

          /*
           * Its own try/catch, because this can run from the ResizeObserver below — outside the
           * promise chain, where the .catch() cannot see a throw. Without it a failure would be
           * silent AND unfallen-back: no vector, no raster, aircraft on white.
           */
          try {
            map.invalidateSize()
            const layer = maplibreGL({ style: BASEMAP_STYLE })
            add(layer)

            /*
             * Watch the GL map itself, not only the code that built it.
             *
             * MapLibre parses tiles in a Web Worker. If that worker cannot start, the background
             * paints and the data never arrives, asynchronously and without an exception. A blank
             * basemap is worse for a reader than a plain one, so that drops to raster too.
             */
            gl = layer.getMaplibreMap?.() ?? null
            if (gl) {
              applyCities()
              gl.on('styledata', applyCities)
              let fellBack = false
              gl.on('error', (ev: { error?: Error }) => {
                console.warn('[map] gl error:', ev?.error)
                if (fellBack || cancelled) return
                fellBack = true
                try { map.removeLayer(layer) } catch { /* already gone */ }
                gl = null
                const i = layers.indexOf(layer)
                if (i >= 0) layers.splice(i, 1)
                useRaster(`gl error: ${ev?.error?.message ?? 'unknown'}`)
              })
            }
          } catch (e) {
            useRaster(`vector attach failed: ${e}`)
          }
        }

        /*
         * ATTACH ONLY ONCE THE CONTAINER HAS A SIZE.
         *
         * The plugin writes map.getSize() onto the div it hands MapLibre. A zero there means
         * MapLibre sees a zero-size container, falls back to a 400x300 canvas and STAYS THERE —
         * it watches the window for resizes, not the element. A correctly-built map painting into
         * a postage stamp, with no error anywhere.
         *
         * A ResizeObserver rather than Leaflet's 'resize' event, which only fires when something
         * calls invalidateSize() — nothing does, so waiting on it would wait forever.
         */
        if (el.clientWidth > 0 && el.clientHeight > 0) {
          attach()
        } else {
          const ro = new ResizeObserver(() => {
            if (el.clientWidth > 0 && el.clientHeight > 0) { ro.disconnect(); attach() }
          })
          ro.observe(el)
          setTimeout(() => {
            if (cancelled) { ro.disconnect(); return }
            if (el.clientWidth === 0 || el.clientHeight === 0) {
              ro.disconnect()
              useRaster('container never sized')
            }
          }, 10_000)
        }
      })
      .catch(e => useRaster(`vector basemap failed: ${e}`))
  }

  return {
    remove() {
      cancelled = true
      gl = null
      for (const layer of layers) {
        try { map.removeLayer(layer) } catch { /* map already torn down */ }
      }
      layers.length = 0
    },
    setCities(on: boolean) {
      cities = on
      // Remembered even when there is no GL map yet: the preference is applied the moment one
      // exists, so toggling while MapLibre is still downloading is not lost.
      applyCities()
    },
  }
}

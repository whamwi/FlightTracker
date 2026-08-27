'use client'

import { useEffect, useRef, useState } from 'react'
import 'leaflet/dist/leaflet.css'
import { attachBasemap, type BasemapHandle } from '@/lib/basemap-attach'
import { getActiveLocale, cityFor } from '@/lib/geo-data'
import { buildV3Popup, type PopupFlight } from '@/lib/v3-popup'

/**
 * The map that draws what the server says, and nothing else.
 *
 * ── Why it exists ──
 *
 * components/Map.tsx runs a FlightPredictor: when a fix stops arriving it dead-reckons the
 * aircraft along its stored route. On 27 Aug ABY364 landed at Sharjah, its fixes turned
 * on_ground, /api/airspace dropped them, and the client filled the silence by projecting it
 * along the DAM–SHJ route — which runs down the Gulf. The marker sat over the sea, nose away
 * from the field, until the arrived-hold expired and it vanished.
 *
 * Nothing here can do that. Every position on this map came from /v2/live, and where the server
 * has nothing to say it says nothing: an arrived flight has no `position`, so it has no marker.
 * The rule the whole phase layer exists to enforce — the map never contradicts the board — holds
 * by construction rather than by care.
 *
 * ── What this is NOT, yet ──
 *
 * Deliberately incomplete, and behind a toggle for that reason. No popups, no schedule ghosts, no
 * Over Syria view, no selection panning, no corridor animation. V2 remains the default and keeps
 * all of it. This draws the basemap, the airports and the aircraft, which is enough to compare
 * the one thing being changed: where the marker goes.
 *
 * Animation comes next, from lib/v3-motion in the app — 169 pure lines with no React in them.
 */

type LivePos = {
  lat: number; lon: number
  altitude_ft: number | null; ground_speed_kts: number | null
  track_deg: number | null; on_ground: boolean | null
  fix_at: string | null; pos_source: string | null
}
type LiveFlight = PopupFlight & {
  callsign: string | null; iata_number: string | null
  dep_iata: string | null; arr_iata: string | null
  phase: string; position: LivePos | null
}

/** Matches components/Map.tsx, so switching does not move the map under the reader. */
const CENTRE: [number, number] = [33.0, 40.0]
const ZOOM = 6
const POLL_MS = 15_000

const SYRIAN = new Set(['DAM', 'ALP', 'DEZ', 'LTK'])

export default function MapV3() {
  const elRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const LRef = useRef<any>(null)
  const basemapRef = useRef<BasemapHandle | null>(null)
  /** One marker per callsign, in one collection — see the note on markers below. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef = useRef<Map<string, any>>(new Map())
  /** The latest document, held apart from the map so the two can arrive in either order. */
  const docRef = useRef<LiveFlight[] | null>(null)
  const [mapReady, setMapReady] = useState(false)
  /** Bumped on each poll, purely to re-run the draw effect. */
  const [tick, setTick] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ok' | 'offline'>('loading')
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!elRef.current || mapRef.current) return
    let cancelled = false

    import('leaflet').then(L => {
      if (cancelled || !elRef.current) return
      LRef.current = L

      const map = L.map(elRef.current, {
        center: CENTRE, zoom: ZOOM,
        zoomControl: false, zoomSnap: 0.25, zoomDelta: 1,
      })
      mapRef.current = map
      L.control.zoom({ position: 'bottomright' }).addTo(map)
      // Tells the draw effect the map exists. A document that arrived first is drawn immediately.
      setMapReady(true)

      // The same basemap V2 uses, so the comparison is about positions and nothing else.
      basemapRef.current = attachBasemap(L, map, 'vector', { cities: false })

      // Syria, and the airports — both from the same sources V2 uses, for the same reason.
      fetch('/syria_adm0.geojson').then(r => r.json()).then(geo => {
        if (mapRef.current !== map) return
        L.geoJSON(geo, {
          style: { color: '#4a7a30', weight: 1.5, opacity: 0.6,
                   fillColor: '#4a7a30', fillOpacity: 0.06, interactive: false },
        }).addTo(map)
      }).catch(() => {})

      fetch('/api/serviced-airports').then(r => r.json()).then(
        (d: { airports?: { iata: string; lat: number; lon: number }[] }) => {
          if (mapRef.current !== map) return
          const ar = getActiveLocale() === 'ar'
          for (const a of d?.airports ?? []) {
            L.circle([a.lat, a.lon], {
              radius: 8000, color: '#e53e3e', fillColor: '#e53e3e', fillOpacity: 0.08,
              weight: 2, dashArray: '4 4', opacity: 0.75, interactive: false,
            }).addTo(map)
            L.marker([a.lat, a.lon], {
              interactive: false, keyboard: false,
              icon: L.divIcon({
                className: '', iconSize: [120, 34], iconAnchor: [60, -6],
                html: `<div style="text-align:center;font:600 10px/1.2 ui-sans-serif,system-ui,sans-serif;
                         color:#8a3b3b;text-shadow:0 0 3px #f4f5f0,0 0 3px #f4f5f0,0 0 3px #f4f5f0;
                         white-space:nowrap">${ar ? cityFor(a.iata) : a.iata}</div>`,
              }),
            }).addTo(map)
          }
        }).catch(() => {})
    })

    return () => {
      cancelled = true
      basemapRef.current?.remove()
      mapRef.current?.remove()
      mapRef.current = null
      markersRef.current.clear()
    }
  }, [])

  /*
   * POLLING, which does not wait for the map.
   *
   * This used to live inside the draw effect and bail out until Leaflet had imported and the map
   * existed — so the first request went out only after the basemap was up, and on a cold load
   * that is fifteen to twenty seconds of an empty map with nothing in flight to explain it. The
   * document and the map have nothing to do with each other; fetching both at once is free.
   */
  useEffect(() => {
    let stop = false

    const poll = async () => {
      try {
        const r = await fetch('/api/live', { cache: 'no-store' })
        const doc = await r.json()
        if (stop) return
        docRef.current = doc?.flights ?? []
        setStatus('ok')
        setTick(t => t + 1)
      } catch {
        // Only report offline before the first success. After that a failed poll leaves the last
        // positions alone — stale by one interval beats an empty map, and the next poll corrects.
        if (!stop) setStatus(s => (s === 'ok' ? 'ok' : 'offline'))
      }
    }

    poll()
    const id = setInterval(poll, POLL_MS)
    return () => { stop = true; clearInterval(id) }
  }, [])

  /*
   * DRAWING, which runs whenever either half is ready — a new document, or the map appearing
   * under a document that is already here.
   *
   * ONE marker per callsign in ONE collection. V2 keeps three — live, schedule ghosts and its
   * Over Syria view — none of which knows about the others, which is how AY352 and ABY352 ended
   * up drawn side by side on 16 Aug. One map, one key, and that fault cannot be expressed.
   */
  useEffect(() => {
    const map = mapRef.current
    const L = LRef.current
    const flights = docRef.current
    if (!mapReady || !map || !L || !flights) return

    // One instant for the whole pass, so two popups built microseconds apart do not report
    // different fix ages for fixes that arrived together.
    const nowMs = Date.now()
    const seen = new Set<string>()

    for (const f of flights) {
      const p = f.position
      // No position means no marker. The server withholds one for an arrived flight, and filling
      // that silence with a guess is the entire bug this map exists to remove.
      if (!p || p.lat == null || p.lon == null) continue

      const cs = (f.callsign || f.iata_number || '').trim()
      if (!cs) continue
      seen.add(cs)

      const syrian = SYRIAN.has(f.dep_iata ?? '') || SYRIAN.has(f.arr_iata ?? '')
      const colour = syrian ? '#2f6b3c' : '#6b7280'
      const faded = p.pos_source === 'projected'
      const icon = L.divIcon({
        className: '',
        iconSize: [96, 52], iconAnchor: [48, 16],
        html: `<div style="font-size:26px;line-height:1;text-align:center;color:${colour};
                 opacity:${faded ? 0.65 : 1};transform:rotate(${(p.track_deg ?? 0) - 90}deg)">&#9992;</div>
               <div style="font:700 11px/1.2 ui-sans-serif,system-ui,sans-serif;text-align:center;
                 color:${colour};white-space:nowrap">${cs}</div>`,
      })

      /*
       * The popup is rebuilt on every poll, not bound once.
       *
       * Its contents are the flight's live state — phase, altitude, how old the fix is — so a
       * popup bound at first sighting would go on describing a flight that had since landed.
       * setPopupContent on an OPEN popup updates it in place, which is what a reader watching an
       * approach should see.
       */
      const html = buildV3Popup(f, nowMs)

      const existing = markersRef.current.get(cs)
      if (existing) {
        existing.setLatLng([p.lat, p.lon])
        existing.setIcon(icon)
        existing.setPopupContent(html)
      } else {
        markersRef.current.set(
          cs,
          L.marker([p.lat, p.lon], { icon }).addTo(map).bindPopup(html, { closeButton: true }),
        )
      }
    }

    // A flight that leaves the document leaves the map. One rule, in one place.
    for (const [cs, m] of markersRef.current) {
      if (!seen.has(cs)) { m.remove(); markersRef.current.delete(cs) }
    }
    setCount(seen.size)
  }, [mapReady, tick])

  return (
    <>
      <div ref={elRef} className="w-full h-full" />
      {/*
        * Always present, and it says which of the three states this is.
        *
        * It used to appear only once flights had been drawn, so the twenty seconds a cold load
        * spends fetching the basemap looked exactly like a map with nothing on it. An empty map
        * that says nothing is indistinguishable from a broken one — and I mistook this for a
        * broken build myself earlier the same day.
        */}
      <div style={{
        position: 'absolute', bottom: 10, left: 10, zIndex: 1000,
        padding: '5px 10px', borderRadius: 8,
        background: 'rgba(237,235,224,0.97)', border: '1px solid #D8D3BF',
        font: '600 11px/1 ui-sans-serif, system-ui, sans-serif',
        color: status === 'offline' ? '#b91c1c' : '#054239',
      }}>
        {status === 'loading' ? 'v3 · loading…'
          : status === 'offline' ? 'v3 · no data'
          : `v3 · ${count} drawn`}
      </div>
    </>
  )
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import 'leaflet/dist/leaflet.css'
import { attachBasemap, type BasemapHandle } from '@/lib/basemap-attach'
import { getActiveLocale, cityFor } from '@/lib/geo-data'
import { translate } from '@/lib/i18n'
import { PANEL } from './MapBox'
import { overflightsInSyria } from '@/lib/overflight'
import { overflightIconHtml, overflightPopupHtml } from '@/lib/overflight-popup'
import { statusBadge, type PopupFlight } from '@/lib/v3-popup'
import { buildPopup, type Aircraft } from '@/lib/flight-popup'
import { advance, ease, pointAt, type Waypoint, type Motion } from '@/lib/v3-motion'

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
  /* How the marker should MOVE between polls — see lib/v3-motion. */
  motion?: Motion | null
  path_key?: string | null
  draw_on_path?: boolean
  callsign: string | null; iata_number: string | null
  dep_iata: string | null; arr_iata: string | null
  phase: string; position: LivePos | null
  /* Times the shared popup renders. Published by /v2/live; absent ones simply do not draw. */
  actual_dep_utc?: string | null; actual_arr_utc?: string | null
  revised_arr_utc?: string | null
  dep_time_utc?: string | null; arr_time_utc?: string | null
}

/** Matches components/Map.tsx, so switching does not move the map under the reader. */
const CENTRE: [number, number] = [33.0, 40.0]
const ZOOM = 6
const POLL_MS = 15_000

const SYRIAN = new Set(['DAM', 'ALP', 'DEZ', 'LTK'])

/**
 * Over Syria polls faster than the board does.
 *
 * These are raw ADS-B fixes and nothing here projects them forward, so a marker is only ever as
 * current as its last poll — the freshness the board gets from motion has to come from the clock
 * instead. Thirty seconds is about half a fix interval, which keeps the lag under one fix without
 * asking for the same aircraft twice.
 */
const AIRSPACE_POLL_MS = 30_000

const T = (k: string) => translate(getActiveLocale(), k)

export default function MapV3({ targetFlight }: { targetFlight?: string }) {
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
  /** The corridors, keyed by path. Held across polls — they change when the learner runs. */
  const pathsRef = useRef<Record<string, Waypoint[]>>({})
  /** When the server built the document: the instant its fractions were true. */
  const asOfRef = useRef<number>(0)
  /*
   * Where each marker is currently DRAWN, carried across frames.
   *
   * Easing needs to know what the reader is looking at, not only what the server last said — a
   * pure function of the document could only ever jump. A ref rather than state: writing where a
   * marker sits must not itself cause a render, or every eased frame would schedule another.
   */
  const shownRef = useRef<Map<string, number>>(new Map())
  const lastTickRef = useRef<number>(0)
  const [mapReady, setMapReady] = useState(false)
  /** Bumped on each poll, purely to re-run the draw effect. */
  const [tick, setTick] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ok' | 'offline'>('loading')

  /*
   * The selected flight, matched on EITHER identifier.
   *
   * Comparing against iata_number alone silently excluded Fly Cham on V2: the panel lists it by
   * its broadcast callsign (FYC489) while the document carries the ticketed number (XH489), so
   * the equality never held. The aircraft drew normally but never highlighted, never panned and
   * never opened — which looked intermittent rather than broken, because every other airline
   * broadcasts what it tickets.
   */
  const targetRef = useRef<string | undefined>(targetFlight)
  targetRef.current = targetFlight
  const matchesTarget = useCallback((f: LiveFlight) => {
    const t = targetRef.current?.trim().toUpperCase()
    if (!t) return false
    return [f.callsign, f.iata_number].some(id => id?.trim().toUpperCase() === t)
  }, [])
  /** Which selection we have already panned to. See the note on the pan effect. */
  const pannedToRef = useRef<string | null>(null)
  /** The marker whose popup WE opened, so clearing the selection can close it again. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const autoOpenedRef = useRef<any>(null)
  const [count, setCount] = useState(0)

  /*
   * OVER SYRIA — aircraft crossing Syrian airspace that are not on the board.
   *
   * Off by default and remembered nowhere, matching V2. It answers a question a reader asks
   * deliberately ("what else is up there?") rather than one the map should answer unprompted, and
   * turning it on doubles the markers over Syria at the zoom most people open at.
   *
   * WHY THIS IS NOT A VIOLATION of the rule that V3 draws only what the server asserts: these are
   * observed fixes, not worked-out ones. What V3 refuses is dead reckoning — continuing to move a
   * marker after the fixes stop — and nothing here moves at all between polls. An aircraft that
   * goes quiet simply stops being returned, and its marker is removed rather than coasting on.
   */
  const [overSyriaOn, setOverSyriaOn] = useState(false)
  /** Kept apart from the board's markers: different feed, different lifetime, different key. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const overMarkersRef = useRef<Map<string, any>>(new Map())
  /** The geofence, fetched once on first use. Null until it lands — see isInSyria. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const syriaGeoRef = useRef<any>(null)
  const [overCount, setOverCount] = useState(0)

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
        const r = await fetch('/api/live?paths=1', { cache: 'no-store' })
        const doc = await r.json()
        if (stop) return
        docRef.current = doc?.flights ?? []
        if (doc?.paths) pathsRef.current = doc.paths
        /*
         * The SERVER's build time, not ours.
         *
         * /v2/live is cached briefly and this polls on its own schedule, so about half the polls
         * return a document that has not changed. Measuring elapsed from the moment we fetched
         * would reset the clock each time while the fraction stayed put — snapping the marker
         * back and re-advancing it. That is the stepping-sideways fault the app hit on 26 Aug.
         */
        asOfRef.current = Date.parse(doc?.as_of ?? '') || Date.now()
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
  /*
   * Which flights move between polls, and where they are drawn.
   *
   * The server decides eligibility: draw_on_path is true for a learned corridor on an airborne
   * aircraft that is not yet arriving. Everything else is drawn at its fix, exactly as before.
   */
  const animatable = useCallback((f: LiveFlight): Waypoint[] | null => {
    if (f.draw_on_path === false || !f.motion || !f.path_key) return null
    return pathsRef.current[f.path_key] ?? null
  }, [])

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

      const selected = matchesTarget(f)
      const syrian = SYRIAN.has(f.dep_iata ?? '') || SYRIAN.has(f.arr_iata ?? '')
      // Selection outranks the route colour: a reader who asked for one flight needs to find it,
      // and which end of the route it serves is the lesser fact while they are looking.
      const colour = selected ? '#c0392b' : syrian ? '#2f6b3c' : '#6b7280'
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
      /*
       * THE SAME popup V2 renders. Only the status is ours.
       *
       * lib/flight-popup builds it from an Aircraft, so the live flight is shaped into one — the
       * fields it reads are the ones /v2/live already carries. Everything below the badge (the
       * progress bar, the local times, the distance remaining, the aircraft type) is presentation
       * that does not care where the position came from, so both maps show it identically and the
       * toggle compares one variable rather than two.
       */
      const ac = {
        hex: cs, flight: cs, lat: p.lat, lon: p.lon,
        alt_baro: p.altitude_ft ?? undefined, gs: p.ground_speed_kts ?? undefined,
        track: p.track_deg ?? undefined,
        dep_iata: f.dep_iata ?? undefined, arr_iata: f.arr_iata ?? undefined,
      } as unknown as Aircraft
      const fs = {
        flight_number: f.iata_number ?? cs,
        dep_iata: f.dep_iata ?? null, arr_iata: f.arr_iata ?? null,
        airline_iata: f.airline_iata ?? null,
        actual_dep_utc: f.actual_dep_utc ?? null,
        actual_arr_utc: f.actual_arr_utc ?? null,
        revised_arr_utc: f.revised_arr_utc ?? null,
        scheduled_dep_utc: f.dep_time_utc ?? null,
        scheduled_arr_utc: f.arr_time_utc ?? null,
      } as unknown as Parameters<typeof buildPopup>[3]

      const html = buildPopup(ac, undefined, p.pos_source === 'projected', fs, null,
                              statusBadge(f, nowMs))

      const existing = markersRef.current.get(cs)
      if (existing) {
        /*
         * A flight being flown along its corridor keeps the position the frame loop gave it.
         * Setting the fix here would snap it back on every poll, which is the leap the corridor
         * exists to remove — the same trap the test page hit on 26 Aug.
         */
        if (!animatable(f)) existing.setLatLng([p.lat, p.lon])
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
  }, [mapReady, tick, animatable, matchesTarget, targetFlight])

  /*
   * Pan to a SELECTION, never to a position.
   *
   * Once per chosen flight, not once per poll. Panning on every document would drag the map out
   * from under anyone who scrolled away from a moving aircraft, and there is no way to tell that
   * apart from the reader having lost interest. The ref remembers which selection has already
   * been honoured, so a flight that moves does not re-centre.
   *
   * Clearing the selection deliberately does not move the map back: the reader is looking at
   * wherever they last were, and returning them somewhere else is not a kindness.
   */
  useEffect(() => {
    if (!mapReady) return
    const map = mapRef.current
    const flights = docRef.current
    if (!map || !flights) return

    if (!targetFlight) {
      pannedToRef.current = null
      /*
       * Close the popup we opened ourselves.
       *
       * It belonged to the selection, so it goes with it — leaving it up says a flight is still
       * chosen when the panel says none is. A popup the READER opened by tapping the marker is
       * not ours to close, which is why only the one we opened is tracked.
       */
      autoOpenedRef.current?.closePopup()
      autoOpenedRef.current = null
      return
    }
    if (pannedToRef.current === targetFlight) return

    const f = flights.find(x => matchesTarget(x))
    const p = f?.position
    if (!f || !p || p.lat == null) return

    pannedToRef.current = targetFlight
    const cs = (f.callsign || f.iata_number || '').trim()
    // Where the marker actually IS, which for an animated flight is its eased position on the
    // corridor rather than its last fix. Panning to the fix would leave it off-centre.
    const marker = markersRef.current.get(cs)
    const at = marker ? marker.getLatLng() : { lat: p.lat, lng: p.lon }
    map.flyTo([at.lat, at.lng], Math.max(map.getZoom(), 7), { duration: 0.8 })
    marker?.openPopup()
    autoOpenedRef.current = marker ?? null
  }, [mapReady, targetFlight, tick, matchesTarget])

  /*
   * The animation, once a second.
   *
   * Separate from the draw effect on purpose. That one rebuilds icons and popup contents, and
   * doing either every second would re-render an open popup under the reader's cursor. This
   * moves markers and nothing else.
   *
   * One second sounds coarse and is not: a flight covers well under a kilometre in that time,
   * which at the opening zoom is a fraction of a pixel. The motion is slow because aeroplanes are
   * far away, not because the clock is lazy.
   */
  useEffect(() => {
    if (!mapReady) return
    const id = setInterval(() => {
      const flights = docRef.current
      if (!flights) return
      const now = Date.now()
      const dt = lastTickRef.current ? (now - lastTickRef.current) / 1000 : 1
      lastTickRef.current = now
      const elapsed = Math.max(0, (now - asOfRef.current) / 1000)

      for (const f of flights) {
        const path = animatable(f)
        if (!path) continue
        const cs = (f.callsign || f.iata_number || '').trim()
        const marker = markersRef.current.get(cs)
        if (!marker) continue

        const target = advance(f.motion ?? null, elapsed)
        if (target === null) continue
        // Eased from wherever this marker actually is, never snapped — see lib/v3-motion.
        // The rate is passed so the marker flies at the aircraft's own speed and only the
        // residual error is eased — see lib/v3-motion.
        const fraction = ease(shownRef.current.get(cs) ?? null, target, dt,
                              f.motion?.fraction_per_sec ?? 0)
        shownRef.current.set(cs, fraction)
        const at = pointAt(path, fraction)
        if (at) marker.setLatLng([at.lat, at.lon])
      }
    }, 1000)
    return () => clearInterval(id)
  }, [mapReady, animatable])

  /*
   * OVER SYRIA: poll only while it is on, and leave nothing behind when it goes off.
   *
   * The whole effect is gated on `overSyriaOn`, so turning it off tears the interval down rather
   * than leaving it running against a hidden layer — this feed is a good deal larger than the
   * board's, and polling it for a layer nobody is looking at is bandwidth spent on nothing.
   */
  useEffect(() => {
    const map = mapRef.current
    const L = LRef.current

    // Clearing runs on the way out of every render of this effect, including the one where the
    // toggle goes off. Markers are removed from the map AND forgotten, so turning it back on
    // rebuilds from the feed rather than resurrecting positions from minutes ago.
    const clear = () => {
      for (const [, m] of overMarkersRef.current) m.remove()
      overMarkersRef.current.clear()
      setOverCount(0)
    }

    if (!overSyriaOn || !mapReady || !map || !L) { clear(); return }

    let stop = false

    const poll = async () => {
      try {
        // The fence is fetched once, on first use rather than at mount — most readers never turn
        // this on, and the file is not small.
        if (!syriaGeoRef.current) {
          const g = await fetch('/syria_adm0.geojson', { cache: 'force-cache' })
          if (stop) return
          syriaGeoRef.current = await g.json()
        }
        const r = await fetch('/api/airspace', { cache: 'no-store' })
        const doc = await r.json()
        if (stop) return
        /*
         * A FEED ERROR IS NOT AN EMPTY SKY.
         *
         * The endpoint answers 200 with ok:false when its upstream fails, and the aircraft list is
         * then empty or absent. Falling through would remove every marker, which draws the same
         * picture as genuinely clear airspace — the reader cannot tell the two apart, and over
         * Syria "nothing is flying" is a claim worth being careful with. Leave the last positions
         * up and let the next poll correct them.
         */
        if (!doc?.ok) return

        const seen = new Set<string>()
        for (const a of overflightsInSyria(doc?.aircraft ?? [], syriaGeoRef.current)) {
          const cs = (a.flight ?? '').trim()
          seen.add(cs)
          /*
           * NOT rotated by -90 like the board's markers.
           *
           * Those draw the ✈ glyph, which points east, so their heading is track minus a quarter
           * turn. This icon is an SVG that already points north, and V2 has always passed the
           * track straight through. Copying the board's offset here would have every overflight
           * flying ninety degrees left of where it is actually going.
           */
          const trackDeg = typeof a.track === 'number' ? a.track : 0
          const icon = L.divIcon({
            className: '',
            html: overflightIconHtml(trackDeg),
            iconSize: [26, 26], iconAnchor: [13, 13],
          })
          const html = overflightPopupHtml(a, trackDeg)
          const existing = overMarkersRef.current.get(cs)
          if (existing) {
            // Straight to the fix, with no easing. There is no motion model behind an overflight
            // — no corridor, no fraction — so the honest thing is to show where it was last seen.
            existing.setLatLng([a.lat, a.lon])
            existing.setIcon(icon)
            existing.setPopupContent(html)
          } else {
            overMarkersRef.current.set(
              cs,
              // Below the board's markers: a flight someone is waiting for outranks traffic
              // passing overhead when the two overlap.
              L.marker([a.lat, a.lon], { icon, zIndexOffset: -200 })
                .addTo(map)
                .bindPopup(html, { className: 'fp-popup', closeButton: false, maxWidth: 280 }),
            )
          }
        }

        for (const [cs, m] of overMarkersRef.current) {
          if (!seen.has(cs)) { m.remove(); overMarkersRef.current.delete(cs) }
        }
        setOverCount(seen.size)
      } catch {
        // A failed poll leaves the last positions alone, as the board's does. The next one
        // corrects, and an empty layer would read as "nothing overhead" rather than "we missed".
      }
    }

    poll()
    const id = setInterval(poll, AIRSPACE_POLL_MS)
    return () => { stop = true; clearInterval(id); clear() }
  }, [overSyriaOn, mapReady])

  return (
    <>
      <style>{`
        /* Desktop only, matching V2: on a phone the top-right stack is most of what you can see,
           and this is a power-user view of non-board traffic rather than anything a passenger
           needs. */
        .mapv3-oversyria { display: none; }
        @media (min-width: 768px) { .mapv3-oversyria { display: flex; } }
      `}</style>
      <div ref={elRef} className="w-full h-full" />
      {/* Same corner and same styling as V2's, so the control does not jump when the reader
          switches between the two maps mid-comparison. */}
      <button
        className="mapv3-oversyria"
        onClick={() => setOverSyriaOn(v => !v)}
        aria-pressed={overSyriaOn}
        title="Show non-board aircraft currently inside Syrian airspace"
        style={{
          position: 'absolute', right: 12, bottom: 24, zIndex: 1000,
          background: overSyriaOn ? PANEL.forest : PANEL.bg,
          color:      overSyriaOn ? '#fff'       : PANEL.secondary,
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
          border: `1px solid ${overSyriaOn ? PANEL.forest : PANEL.border}`,
          borderRadius: 12, padding: '8px 12px',
          font: `600 12px/1 'Instrument Sans', system-ui`, letterSpacing: '-.01em',
          cursor: 'pointer', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
          boxShadow: '0 4px 28px rgba(0,0,0,.13)',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
        </svg>
        {T('map.over_syria')}
      </button>
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
          /* The two counts are kept apart rather than summed: they come from different feeds and
             mean different things, and one number would make a quiet board look busy. */
          : `v3 · ${count} drawn${overSyriaOn ? ` · ${overCount} over` : ''}`}
      </div>
    </>
  )
}

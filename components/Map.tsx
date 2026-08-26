'use client'
import { PHONE_MQ } from '@/lib/breakpoints'
import { carryArrival } from '@/lib/flight-leg'
import { hasArrived, canonicalStatus, calcDelay } from '@/lib/flight-status'
import { climbAdjustedFraction } from '@/lib/climb-profile'
import { airportTimeParts } from '@/lib/airport-time'
import { reportHandledError } from './ErrorReporter'

import 'leaflet/dist/leaflet.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FlightPredictor } from '@/lib/flight-predictor'
import type { LivePosition as PredictorLivePos } from '@/lib/flight-predictor'
import { airlineLogo, LOGO_WHITE_BG } from '@/lib/airlines'
import { TrackerStore, type FlightInput } from '@/lib/tracker-store'
import {
  attachBasemap, storedBasemap, storeBasemap, storedCities, storeCities,
  type BasemapKind, type BasemapHandle,
} from '@/lib/basemap-attach'
import VideoBox from './VideoBox'

// Path-anchored motion: markers are positioned by the animation loop rather than written
// once per poll. Set false to fall back to the poll writing positions directly.
const RAF_MOTION = true
import PhotoBox from './PhotoBox'
import AirportLegend from './AirportLegend'
import BasemapSwitcher from './BasemapSwitcher'
import { PANEL } from './MapBox'
import { translate, counted } from '@/lib/i18n'
import { getActiveLocale, cityFor, airportLabelFor } from '@/lib/geo-data'
import { markerHub, MARKER_ACCENT, isSyrianAirport, SYRIA_AIRPORT_SET, type BoardAirport } from '@/lib/syria-airports'

/*
 * The popups are built as HTML strings from module-level functions, so there is no hook to
 * read the locale from. LocaleProvider sets it on the module during render and a popup is
 * only ever built afterwards, in response to a click or a poll — so by the time these run
 * the value is there.
 */
const T   = (k: string) => translate(getActiveLocale(), k)
const RTL = () => getActiveLocale() === 'ar'

interface Aircraft {
  hex: string
  /** Optional: present when the row came from the board, absent on a bare position. */
  eta_stable_utc?: string | null
  flight: string
  lat: number
  lon: number
  alt_baro: number | string | null
  gs: number | null
  track: number | null
  true_heading: number | null
  nic?: number
  nac_p?: number
  t: string | null
  r: string | null
  board_match:    boolean
  /**
   * Seconds since the position under this row was actually observed.
   *
   * The airspace route has emitted it all along and this component never read it, which is how a
   * card came to show a green badge over an altitude, a speed and a distance from a fix four
   * minutes old — TKJ340 into Aleppo on 15 Aug, frozen at 16.6 km and 8,025 ft while it landed.
   * The panel was already consuming the same field; the map was not, and one surface knowing a
   * fact the other does not is the shape most of these defects have taken.
   */
  fix_age_s?:     number | null
  dep_iata:       string | null
  arr_iata:       string | null
  dep_time_utc?:  string | null   // scheduled "HH:MM" UTC — popup fallback when no status
  arr_time_utc:   string | null
  duration_min:   number | null
  iata_number:    string | null
  actual_dep_utc: string | null
  actual_arr_utc: string | null
  /** The board's revised arrival, carried through so the popup need not synthesise one. */
  revised_arr_utc?: string | null
  /**
   * The board's own status for this flight, lowercased by the airspace route.
   *
   * Named apart from anything the position feed carries: this is the server's verdict on the
   * flight, not a description of the fix.
   */
  board_status?: string | null
  dep_delay_min:  number | null
  airline_iata:   string | null
  seen_at?: string
  /**
   * When the position was actually taken, as opposed to when we received it.
   *
   * The airspace route has always emitted this; the type simply never declared it, so the one
   * place that read it did so through an `as any`. It is the only honest way to tell two fixes
   * apart — see the tracking update, which used to compare ground speeds instead and froze every
   * arriving aircraft at its cruise reading.
   */
  fix_at?:  string
  stale?:   boolean
}

interface Waypoint {
  f: number
  lat: number
  lon: number
}

interface ScheduleEntry {
  callsign:     string
  dep_iata:     string
  arr_iata:     string
  /**
   * "HH:MM", or null when this entry was synthesised for a flight the board reported as
   * departed but which has no timetable row. Nullable rather than a placeholder: '00:00' was
   * indistinguishable from a real midnight departure, and anything measuring against it got a
   * silent, plausible-looking answer.
   */
  dep_time_utc: string | null
  arr_time_utc: string | null
  duration_min: number
  days_of_week: string[]
}

interface FlightStatus {
  callsign:          string
  status:            string   // Expected | Departed | Arrived | Unknown | Cancelled
  actual_dep_utc:    string | null
  actual_arr_utc:    string | null
  scheduled_dep_utc: string | null
  scheduled_arr_utc: string | null
  revised_dep_utc:   string | null
  revised_arr_utc:   string | null
  /** The arrival estimate damped server-side — what every countdown runs to. */
  eta_stable_utc:    string | null
  dep_delay_min:     number | null
  arr_delay_min:     number | null
  aircraft_reg:      string | null
  aircraft_type:     string | null
  flight_number:     string | null
  dep_iata:          string | null
  arr_iata:          string | null
  airline_iata:      string | null
}

import { airportFlag as _apFlag, airportCoords as _apCoords, airportOffset as _apOffset, airlineByIata as _alByIata, icaoToIata as _icaoToIata, loadGeoData } from '../lib/geo-data'

function iataCity(code: string | null | undefined): string {
  return code ? cityFor(code) : '—'
}
function airlineIataFor(callsign: string, fs?: FlightStatus | null): string | null {
  if (fs?.airline_iata) return fs.airline_iata
  const src = fs?.flight_number ?? callsign
  const m = src.match(/^([A-Z0-9]{2})\d/i)
  if (m) return m[1].toUpperCase()
  const icao = callsign.replace(/\d/g, '').toUpperCase()
  return _icaoToIata[icao] ?? null
}
function airlineNameFor(iata: string | null): string | null {
  if (!iata) return null
  const row = _alByIata[iata]
  if (!row) return null
  return (RTL() ? (row.name_ar || row.name_en) : row.name_en) ?? null
}
// Syria home airports — tiny fallback so route lines draw before geo-data loads
const AIRPORT_COORDS: Record<string, [number, number]> = {
  DAM: [33.4114, 36.5156],
  ALP: [36.1807, 37.2244],
}

const STALE_TTL_MS       = 30 * 60 * 1000
/**
 * How long a confirmed arrival stays on the map.
 *
 * The comment below this constant's old inline value said 30 minutes while the code said 90,
 * and mobile independently used 90 — so an arrived flight lingered far longer than intended
 * on both. One constant now, and both surfaces use 30.
 */
/**
 * How arrived markers share the space around an airport they are all sitting on.
 *
 * Damascus can hold eleven of them inside the hour they linger, every one at the field's exact
 * coordinate: eleven aircraft, eleven ARRIVED labels, one unreadable blob.
 *
 * The first attempt backed each one 8 km along the route it flew, so the Dubai arrival sat
 * south-east of the field and the Istanbul one north-west — an arrangement that means something
 * rather than a fan of arbitrary offsets. Measured on the deployed map it did almost nothing:
 * 8 km is two to five pixels at the zoom the country is viewed at, and two flights on the same
 * route — ABY434 and FYC741, both from Sharjah — came out exactly on top of each other, because
 * the same route backs off in the same direction.
 *
 * So the distance moves into pixels and the direction keeps its meaning. Each marker still sits
 * back along its own approach, now at a separation that survives zooming out, and when two
 * approaches are too close together the second is stepped around the field until it is clear.
 * Once a full turn is used up the next one goes to a wider ring.
 */

/*
 * Several arrivals at one airport become one badge, not a fan around it.
 *
 * Three attempts moved the marker instead: 8 km along the route (two pixels when zoomed out), a
 * fixed 52 px (which put a Kuwait arrival in the Iraqi desert), then a capped version of the same.
 * Every one of them traded a true position for legibility, and a marker's position is the one
 * thing on this map that must not be traded.
 *
 * So nothing moves. A lone arrival is drawn as it always was, exactly on its field. Two or more
 * collapse into a single badge sitting on that same field, which opens into a list. Nobody is
 * displaced and nobody is hidden.
 */

/*
 * How long an arrived flight stays drawn. Matches the same constant in app/api/airspace/route.ts,
 * and now the mobile app's ARRIVED_HOLD_MIN too — these were 30 minutes in one place, an hour in
 * another and four hours in a third, so a flight left the map at a different moment depending on
 * which surface you were looking at and whether we still held a fix for it.
 */
/**
 * How long the most recent arrival stays drawn at its airport.
 *
 * Sixty minutes, and it governs two things that must not disagree: how long the marker is shown,
 * and how long the tracked entry behind it is kept. It was thirty for the entry alone, which would
 * have deleted the flight halfway through its hour on the map.
 */
const ARRIVED_HOLD_MS    = 60 * 60 * 1000

/**
 * Inside this distance from the destination the popup stops quoting altitude and speed.
 *
 * The numbers are real but they expire faster than the ten-second poll can replace them, so what
 * a reader sees is always a moment behind the aeroplane — and on final that moment is the
 * difference between flying and landed.
 */
const FINAL_RING_KM = 10

/**
 * How old a fix may be before the aircraft is treated as no longer reporting.
 *
 * Measured 15 Aug 2026 over 637 observations of 19 aircraft, sampling every aircraft in the feed
 * every fifteen seconds:
 *
 *   fix_age_s   p50 1s · p90 48s · p99 68s · max 113s
 *
 * A healthy feed never reached two minutes. A dying one is unmistakable by contrast — TKJ340's
 * track sat at 218s and climbing while the aircraft descended into Aleppo.
 *
 * 150s sits in the gap: above every healthy observation with a third to spare, and well below the
 * dying signature. The margin is the point, because the cost of being too tight is measured too —
 * every observation up to 120s was followed by a fresh fix, 100% of them, so a two-minute
 * threshold would have blanked flights that were about to report. There is no such evidence above
 * 150s in either direction, which is the honest reason not to cut it finer.
 */
const STALE_FIX_MS = 150 * 1000

// Flights to and from these are "ours", and decide which half of a leg is worth drawing. From
// lib/syria-airports rather than spelled out again — this file had its own copy, which is the
// drift that module exists to stop, and DEZ opening in August is how it gets noticed.
const HOME_AIRPORTS = SYRIA_AIRPORT_SET
const STALE_TTL_SYRIA_MS = 6  * 60 * 60 * 1000



/**
 * The second line of a marker label: the end of the journey that is not Syria.
 *
 * Was always the destination, which meant every inbound marker read "إلى: دمشق" — 40 of the 74
 * flights that departed on 14 Aug were inbound, and they share two destinations between them, so
 * half the map would have carried the same line. Worse, it was saying a third time what the marker
 * already says twice: the icon is green for Damascus and orange for Aleppo, so the Syrian end is
 * in the colour before any text is read.
 *
 * The far end instead, with the preposition carrying the direction — من: دبي inbound, إلى: دبي
 * outbound. This is the rule the phone strip has always used; the map disagreeing with it was a
 * disagreement introduced by hand, in a codebase where the whole point is that surfaces agree.
 *
 * A domestic leg has two Syrian ends and takes the arrival, which is the one that differs.
 */
function destinationLine(dep: string | null, arr: string | null): string | null {
  if (!dep || !arr) return null
  const outbound = isSyrianAirport(dep)
  const far = outbound ? arr : dep
  return `${T(outbound ? 'map.to' : 'map.from')} ${cityFor(far)}`
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R    = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a    = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

function projectPosition(lat: number, lon: number, trackDeg: number, speedKts: number, elapsedMs: number): [number, number] {
  const distKm   = speedKts * 1.852 * (elapsedMs / 3_600_000)
  const trackRad = (trackDeg * Math.PI) / 180
  const newLat   = lat + (distKm * Math.cos(trackRad)) / 111.32
  const newLon   = lon + (distKm * Math.sin(trackRad)) / (111.32 * Math.cos((lat * Math.PI) / 180))
  return [newLat, newLon]
}

// ── Route-path helpers ────────────────────────────────────────────────────────

function interpolatePath(wps: Waypoint[], f: number): [number, number] {
  if (!wps.length) return [0, 0]
  if (f <= wps[0].f) return [wps[0].lat, wps[0].lon]
  const last = wps[wps.length - 1]
  if (f >= last.f) return [last.lat, last.lon]
  let lo = 0, hi = wps.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (wps[mid].f <= f) lo = mid; else hi = mid
  }
  const a = wps[lo], b = wps[hi]
  const t = (f - a.f) / (b.f - a.f)
  return [a.lat + t * (b.lat - a.lat), a.lon + t * (b.lon - a.lon)]
}

// Finds the waypoint fraction on the path geometrically nearest to (lat, lon).
// Used to re-anchor the DR projection when the live signal is off-schedule.
function nearestPathFraction(wps: Waypoint[], lat: number, lon: number): number {
  let bestF = wps[0]?.f ?? 0
  let bestDist = Infinity
  for (const wp of wps) {
    const d = greatCircleKm(lat, lon, wp.lat, wp.lon)
    if (d < bestDist) { bestDist = d; bestF = wp.f }
  }
  return bestF
}

function bearingFromPath(wps: Waypoint[], f: number): number {
  const dt = 0.01
  const [aLat, aLon] = interpolatePath(wps, Math.max(0, f - dt / 2))
  const [bLat, bLon] = interpolatePath(wps, Math.min(1, f + dt / 2))
  const dLon = (bLon - aLon) * Math.PI / 180
  const y = Math.sin(dLon) * Math.cos(bLat * Math.PI / 180)
  const x = Math.cos(aLat * Math.PI / 180) * Math.sin(bLat * Math.PI / 180)
           - Math.sin(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.cos(dLon)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

function slerpGreatCircle(lat1: number, lon1: number, lat2: number, lon2: number, t: number): [number, number] {
  const r = Math.PI / 180
  const φ1 = lat1 * r, λ1 = lon1 * r, φ2 = lat2 * r, λ2 = lon2 * r
  const x1 = Math.cos(φ1)*Math.cos(λ1), y1 = Math.cos(φ1)*Math.sin(λ1), z1 = Math.sin(φ1)
  const x2 = Math.cos(φ2)*Math.cos(λ2), y2 = Math.cos(φ2)*Math.sin(λ2), z2 = Math.sin(φ2)
  const dot   = Math.min(1, Math.max(-1, x1*x2 + y1*y2 + z1*z2))
  const omega = Math.acos(dot)
  if (Math.abs(omega) < 1e-6) return [lat1, lon1]
  const sinO = Math.sin(omega)
  const w1 = Math.sin((1 - t) * omega) / sinO
  const w2 = Math.sin(t       * omega) / sinO
  const x = w1*x1 + w2*x2, y = w1*y1 + w2*y2, z = w1*z1 + w2*z2
  return [Math.atan2(z, Math.sqrt(x*x + y*y)) * 180/Math.PI, Math.atan2(y, x) * 180/Math.PI]
}

function bearingAlongPath(lat1: number, lon1: number, lat2: number, lon2: number, t: number): number {
  const dt = Math.min(0.005, (1 - t) * 0.5)
  const [aLat, aLon] = slerpGreatCircle(lat1, lon1, lat2, lon2, t)
  const [bLat, bLon] = slerpGreatCircle(lat1, lon1, lat2, lon2, Math.min(1, t + dt))
  const dLon = (bLon - aLon) * Math.PI / 180
  const y = Math.sin(dLon) * Math.cos(bLat * Math.PI / 180)
  const x = Math.cos(aLat * Math.PI / 180) * Math.sin(bLat * Math.PI / 180)
           - Math.sin(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.cos(dLon)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}


// Returns fraction (0–1) of flight elapsed (second precision), or null if not active right now
/**
 * The timetable row for a callsign ON THE DAY BEING FLOWN.
 *
 * route_master holds one row per operating day, and they are not the same flight in any
 * useful sense: XH525 leaves Aleppo at 16:00 on a Friday and 18:00 on a Tuesday. Ten call
 * sites took the first row matching the callsign, so on a Tuesday the map had an even chance
 * of reasoning from Friday's timetable — two hours out, silently.
 *
 * Days are compared UTC, matching isFlightActiveNow, and normalised because stored rows use
 * 'tue' while synthesised ones use 'Tue'.
 *
 * Falls back to the first row when no day matches: a flight the board says is airborne is
 * airborne whatever the timetable claims, and a wrong-day row still carries the right
 * airports and a usable block time.
 */
function pickSchedule(entries: ScheduleEntry[], cs: string, nowMs: number): ScheduleEntry | undefined {
  const rows = entries.filter(e => e.callsign === cs)
  if (rows.length < 2) return rows[0]
  const today = ['sun','mon','tue','wed','thu','fri','sat'][new Date(nowMs).getUTCDay()]
  return rows.find(e => e.days_of_week?.some(d => d.toLowerCase().slice(0, 3) === today)) ?? rows[0]
}

function isFlightActiveNow(depUtc: string | null, arrUtc: string | null, days: string[], nowMs: number): number | null {
  if (!depUtc || !arrUtc || depUtc === '—' || arrUtc === '—') return null
  const toSec = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 3600 + m * 60 }
  const depSec = toSec(depUtc)
  const arrSec = toSec(arrUtc)
  const durSec = arrSec > depSec ? arrSec - depSec : 86400 - depSec + arrSec
  if (durSec <= 0) return null

  const now    = new Date(nowMs)
  const DAYS   = ['sun','mon','tue','wed','thu','fri','sat']
  const todayI = now.getUTCDay()
  const nowSec = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()

  const POST_SEC = 30 * 60 // 30-min post-arrival freeze at destination

  if (arrSec > depSec) {
    // Same-day flight — in-flight
    if (days.includes(DAYS[todayI]) && nowSec >= depSec && nowSec <= arrSec)
      return (nowSec - depSec) / durSec
    // Same-day flight — post-arrival freeze
    if (days.includes(DAYS[todayI]) && nowSec > arrSec && nowSec <= arrSec + POST_SEC)
      return 1.1
    return null
  }

  // Overnight: departs today before midnight
  if (days.includes(DAYS[todayI]) && nowSec >= depSec)
    return (nowSec - depSec) / durSec

  // Overnight: departed yesterday, still flying
  const yIdx = (todayI + 6) % 7
  if (days.includes(DAYS[yIdx]) && nowSec <= arrSec)
    return (86400 - depSec + nowSec) / durSec
  // Overnight: post-arrival freeze (arrived today, within 30 min)
  if (days.includes(DAYS[yIdx]) && nowSec > arrSec && nowSec <= arrSec + POST_SEC)
    return 1.1

  return null
}

// Return the most reliable heading for icon rotation.
// When nic=0 (GPS unreliable), track can be wildly wrong while true_heading
// stays accurate (derived from IRS/inertial). If they disagree by >45° use heading.
function bestHeading(a: Aircraft): number {
  const trk = a.track
  const hdg = a.true_heading
  if (trk == null) return hdg ?? 0
  if (hdg  == null) return trk
  const diff = Math.abs(((trk - hdg) + 540) % 360 - 180)
  return diff > 45 ? hdg : trk
}


// ── Icon & popup ──────────────────────────────────────────────────────────────

function planeIcon(L: typeof import('leaflet'), track: number, syria: boolean, stale: boolean, label?: string, hub: BoardAirport = 'DAM', estimated = false, colorOverride?: string) {
  const mobile  = typeof window !== 'undefined' && window.matchMedia(PHONE_MQ).matches
  const size    = syria ? (mobile ? 36 : 40) : (mobile ? 26 : 30)
  // Was a boolean — Aleppo orange, any other Syrian airport green — which painted Deir ez-Zor
  // as Damascus from the day it opened. The table is shared with the mobile app so the two
  // maps cannot drift apart again.
  const color   = colorOverride ?? (stale ? '#9ca3af' : syria ? MARKER_ACCENT[hub] : '#1d4ed8')
  const opacity = stale ? 0.5 : 1
  const shadow  = syria && !stale ? 'drop-shadow(0 5px 4px rgba(0,0,0,0.45))' : 'drop-shadow(0 1px 3px rgba(0,0,0,0.4))'
  const strokeW = syria && !stale ? 0.4 : 0.6
  const path    = `M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z`

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"
    style="transform:rotate(${track}deg);opacity:${opacity};filter:${shadow}">
    <path fill="${color}" stroke="white" stroke-width="${strokeW}" d="${path}"/>
  </svg>`

  let html = svg
  if (label) {
    /*
     * The arrived label is the quietest thing on the map, and should look it.
     *
     * `stale` here means arrSnapped — one flight held at its airport for an hour after landing, so
     * a reader can see what just came in. It is history, not traffic: it is not moving, nothing
     * about it will change, and it sits still while everything around it does not. #6b7280 gave it
     * the same weight as a live flight's label.
     *
     * #9ca3af is the fill the snapped marker itself already uses, so the label and the icon it
     * belongs to now read as one object rather than a grey plane under a dark caption.
     */
    const textColor = stale ? '#9ca3af' : estimated ? '#d97706' : '#166534'
    /*
     * The second line is quieter than the first, because it is answering a different question.
     *
     * Line one is which flight this is; line two is where it is going. Amber and bold on line two
     * was for the old ARRIVED tag, which shouted for attention it needed — a destination does not,
     * and every marker carrying one would have made the map a wall of yellow.
     */
    const labelHtml = label.split('\n').map((line, i) =>
      `<div style="font-size:${mobile ? 8 : (i > 0 ? 8 : 9)}px;font-weight:${i > 0 ? 600 : 'bold'};`
      + `color:${i > 0 ? (stale ? '#9ca3af' : '#6b7280') : textColor};letter-spacing:0.3px;line-height:1.2;`
      + `white-space:nowrap">${line}</div>`
    ).join('')
    html = `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
      ${svg}<div style="text-align:center">${labelHtml}</div></div>`
  }

  return L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
}

// Convert UTC ISO timestamp to local "HH:MM" using airport UTC offset
/**
 * Kept as a thin shim over lib/airport-time so the popup resolves zones like every other surface.
 *
 * It used to add a stored number of hours, which is right for every Middle Eastern airport we serve
 * and an hour out for the European ones half the year. The signature keeps its offset argument
 * because six call sites pass one; the argument is now ignored, and the IATA code decides.
 */
function popupToLocal(iso: string | null, _offset: number, iata = 'DAM'): string {
  if (!iso) return ''
  const { time, meridiem } = airportTimeParts(iso, iata)
  if (!meridiem) return time
  // Same intent as the panel card: the meridiem is a qualifier, so it takes the face used for
  // airline names and a smaller size rather than competing with the digits at full weight.
  return `<span dir="ltr">${time}<span style="font:500 9px/1 'Instrument Sans',system-ui;`
       + `margin-inline-start:3px;opacity:.75">${meridiem}</span></span>`
}

// Convert UTC "HH:MM" schedule time to local using airport UTC offset
function schedToLocal(hhmm: string | null, offset: number): string {
  // A synthesised schedule entry has no times. An em dash is the honest render; the old
  // '00:00' placeholder made a flight with no timetable look like a midnight departure.
  if (!hhmm) return '—'
  const [h, m] = hhmm.split(':').map(Number)
  const total = h * 60 + m + Math.round(offset * 60)
  const lh = Math.floor(((total % 1440) + 1440) % 1440 / 60)
  const lm = ((total % 1440) + 1440) % 1440 % 60
  return `${String(lh).padStart(2,'0')}:${String(lm).padStart(2,'0')}`
}

// Arabic carries no English unit letters — see the twin in FlightDetail.
const fmtHm = (m: number) => RTL()
  ? (m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : counted('ar', m, 'noun.minute'))
  : (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`)

/**
 * The flight number and the broadcast callsign are two different identifiers for the same
 * flight — 3L505 is what a passenger sees on a ticket and what FR24 publishes; ADY505 is
 * what the aircraft actually transmits and what every ADS-B tracker keys on. They are often
 * unrelated strings (RB444/SYR444, XQ808/SXS808, DN541/DNA541), so showing only one leaves
 * a user unable to reconcile our card with what they see elsewhere.
 *
 * Rendered as "3L505 · ADY505" — flight identity only. The aircraft type is deliberately
 * not here; this line answers "which flight is this", and the type competed with that.
 *
 * The callsign is omitted when identical to the flight number, which matters for the 38
 * flights where fr24_uses_callsign is true.
 */
function identityLine(flightNum: string | null | undefined, callsign: string | null | undefined): string {
  const fn = (flightNum ?? '').trim()
  const cs = (callsign  ?? '').trim()
  const parts: string[] = []
  if (fn) parts.push(fn)
  if (cs && cs.toUpperCase() !== fn.toUpperCase()) parts.push(cs)
  return parts.join(' · ')
}

// One progress bar for both popup builders.
//
// They had drifted into two designs: a flex layout with an 18px circled SVG marker, and an
// absolutely-positioned 3px track with a `✈` text glyph. Because a flight hands off between
// the tracked marker and the schedule overlay as its signal comes and goes, the *same*
// flight rendered one way on one refresh and the other way on the next. Two implementations
// of one component will always drift; there is now one.
/**
 * `belowStr` is optional and defaults to empty, which is what keeps buildSchedulePopup honest.
 *
 * That builder draws flights projected along a stored route, where every position is computed
 * rather than observed — so a distance printed under its bar would be arithmetic on a guess, and a
 * reader has no way to tell that from a measurement. It simply never passes one.
 */
function progressBarHtml(dep: string | null, arr: string | null, fraction: number | null, etaStr: string, belowStr = ''): string {
  if (!dep || !arr) return ''
  const fillPct  = fraction != null ? Math.max(1, Math.round(fraction * 100))       : 0
  const emptyPct = fraction != null ? Math.max(1, Math.round((1 - fraction) * 100)) : 100
  return `<div style="padding:4px 14px 12px">
        ${etaStr ? `<div style="text-align:center;color:#9ca3af;font-size:11px;margin-bottom:8px">${etaStr}</div>` : ''}
        <div style="display:flex;align-items:center;gap:8px">
          <div style="text-align:start">
            <div style="font-size:12px;color:#d1d5db;white-space:nowrap">${_apFlag[dep] ?? ''} ${iataCity(dep)}</div>
            <div style="font-size:10px;color:#6b7280;font-family:monospace">${dep}</div>
          </div>
          <div style="flex:1;display:flex;flex-direction:row;align-items:center;height:20px">
            <div style="flex:${fillPct};height:4px;border-radius:99px;background:${fraction!=null?'#3b82f6':'#374151'};min-width:0"></div>
            ${fraction != null ? `
              <div style="width:18px;height:18px;border-radius:9px;background:#1e293b;flex-shrink:0;border:1.5px solid #3b82f6;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 5px rgba(59,130,246,.3)">
                <svg width="9" height="9" viewBox="0 0 10 10" fill="#3b82f6"${RTL() ? ' style="transform:scaleX(-1)"' : ''}><path d="M.7 1.1 9.3 5 .7 8.9 2.5 5z"/></svg>
              </div>
              <div style="flex:${emptyPct};height:4px;border-radius:99px;background:#374151;min-width:0"></div>
            ` : ''}
          </div>
          <div style="text-align:end">
            <div style="font-size:12px;color:#d1d5db;white-space:nowrap">${iataCity(arr)} ${_apFlag[arr] ?? ''}</div>
            <div style="font-size:10px;color:#6b7280;font-family:monospace;text-align:end">${arr}</div>
          </div>
        </div>
        <!-- 2px here against the countdown's 8px above, which looks asymmetric written down and
             reads as even on screen: the row above this line ends in the two IATA codes, so there
             is already a band of empty space under the bar itself before the row closes. Matching
             the numbers would leave this line floating away from the bar it belongs to. -->
        ${belowStr ? `<div style="text-align:center;color:#9ca3af;font-size:11px;margin-top:2px">${belowStr}</div>` : ''}
      </div>`
}

function buildPopup(
  a: Aircraft,
  lostAt?: number,
  projected?: boolean,
  fs?: FlightStatus | null,
  photoUrl?: string | null,
): string {
  const callsign  = (a.flight ?? '').trim() || a.hex
  const aiata     = airlineIataFor(callsign, fs)
  const alName    = airlineNameFor(aiata) ?? (aiata ?? callsign)
  const acType    = fs?.aircraft_type ?? a.t ?? null
  const dep       = fs?.dep_iata ?? a.dep_iata ?? null
  const arr       = fs?.arr_iata ?? a.arr_iata ?? null
  const flightNum = fs?.flight_number ?? callsign

  /*
   * Arrived first, and from lib/flight-status — the rule the board, the panel and the schedule
   * marker already share.
   *
   * This popup had no arrived state at all: the three branches below were signal-lost, projected
   * and in-air, so an aircraft that had landed showed whichever of those last applied. ABY433 on
   * 14 Aug read "انقطعت الإشارة" under a marker labelled ARRIVED, and THY848 read "~ في الجو"
   * with its landing time printed directly underneath.
   *
   * Signal-lost is exactly the case that has to yield. Losing the track is how most of these
   * flights end — FR24 drops them on approach at Aleppo — so reporting the loss instead of the
   * landing describes our coverage rather than the flight.
   */
  const arrived = hasArrived({
    status:          fs?.status,
    actual_arr_utc:  fs?.actual_arr_utc ?? a.actual_arr_utc,
    actual_dep_utc:  fs?.actual_dep_utc ?? a.actual_dep_utc,
    revised_arr_utc: fs?.revised_arr_utc,
    duration_min:    a.duration_min,
  })

  // Status badge. Same colours as buildSchedulePopup's arrived state, so a flight handing over
  // between the two builders does not change appearance as it does so.
  const [statusLabel, statusBg, statusFg] = arrived
    ? [T('status.arrived'), '#1e3a5f', '#60a5fa']
    : lostAt && !projected
    ? [T('status.signal_lost'), '#7f1d1d', '#f87171']
    // The tilde marks a projected position rather than an observed one.
    : projected
      ? [`~ ${T('status.in_air')}`, '#713f12', '#fbbf24']
      : [T('status.in_air'), '#166534', '#4ade80']

  // Airline logo
  const logoHtml = aiata
    ? `<img src="${airlineLogo(aiata)}"
        style="width:44px;height:44px;border-radius:10px;object-fit:contain;${LOGO_WHITE_BG.has(aiata) ? 'background:#fff;' : ''}padding:4px;flex-shrink:0"
        onerror="this.src='https://images.flightsfrom.com/airlines/100/${aiata}_100px.png';this.onerror=null">`
    : `<div style="width:44px;height:44px;border-radius:10px;background:#1f2937;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:22px">${_apFlag[dep ?? ''] || '✈'}</div>`

  const depCoord = dep ? _apCoords[dep] : null
  const arrCoord = arr ? _apCoords[arr] : null

  // ONE resolved pair of instants drives the progress bar, the countdown and the ARRIVAL
  // column. Keeping them on separate chains is how a card ends up reading "ARRIVAL 02:52"
  // beside "26m left" — each defensible alone, nonsense together.
  const depISO = fs?.actual_dep_utc ?? a.actual_dep_utc ?? null
  /*
   * eta_stable_utc ahead of revised_arr_utc: the same instant, damped once on the server so
   * every surface counts to one number.
   *
   * The countdown moved with every estimate FR24 published, and it republishes constantly —
   * RB515 alternated between two values five times in forty minutes, so a reader watched
   * "16m left" become "23m" and back. The app damped this and the site did not, which is how
   * SDR17HL read "3:42 left" here and "3 hours 39 minutes" on the phone at the same moment.
   * Now neither client damps and both read the same field. revised_arr_utc stays as the
   * fallback for anything the service has not stabilised.
   */
  const arrISO = fs?.actual_arr_utc ?? fs?.eta_stable_utc ?? fs?.revised_arr_utc ?? fs?.scheduled_arr_utc
    ?? (() => {
      const d = Date.parse(depISO ?? '')
      return Number.isFinite(d) && a.duration_min
        ? new Date(d + a.duration_min * 60_000).toISOString()
        : null
    })()

  const depMs       = Date.parse(depISO ?? '')
  const arrMs       = Date.parse(arrISO ?? '')
  // Kept for the flown-time figure below; whether it has landed is `arrived`, decided above.
  const actualArrMs = Date.parse(fs?.actual_arr_utc ?? a.actual_arr_utc ?? '')

  // Progress from time, not from a.lat/a.lon. Those freeze at the instant the signal drops,
  // so on a dead-reckoned flight the bar froze with them — while the schedule overlay
  // computed the same flight's progress from time. The result was a bar that jumped
  // position depending on which builder happened to render it that refresh. Geometry stays
  // only as a fallback for a live aircraft with no usable schedule.
  let fraction: number | null = null
  if (arrived) {
    fraction = 1
  } else if (Number.isFinite(depMs) && Number.isFinite(arrMs) && arrMs > depMs) {
    fraction = Math.max(0.02, Math.min(0.97, (Date.now() - depMs) / (arrMs - depMs)))
  } else if (depCoord && arrCoord && typeof a.lat === 'number' && typeof a.lon === 'number') {
    const total = greatCircleKm(depCoord[0], depCoord[1], arrCoord[0], arrCoord[1])
    const rem   = greatCircleKm(a.lat, a.lon, arrCoord[0], arrCoord[1])
    fraction = total > 0 ? Math.max(0.02, Math.min(0.97, 1 - rem / total)) : null
  }

  // Times (local at each airport)
  const depOffset = _apOffset[dep ?? ''] ?? 3
  const arrOffset = _apOffset[arr ?? ''] ?? 3

  let etaStr = ''
  if (arrived && Number.isFinite(actualArrMs) && Number.isFinite(depMs) && actualArrMs > depMs) {
    // Once it is down, time remaining is meaningless — how long it took is the useful number.
    etaStr = `${fmtHm(Math.round((actualArrMs - depMs) / 60_000))} ${T('label.flown')}`
  } else if (!arrived && Number.isFinite(arrMs)) {
    const remMin = Math.round((arrMs - Date.now()) / 60_000)
    if (remMin > 0) etaStr = `${fmtHm(remMin)} ${T('map.until_arrival')}`
  } else if (!arrived && arrCoord && typeof a.lat === 'number' && typeof a.lon === 'number'
             && typeof a.gs === 'number' && a.gs > 50) {
    // No arrival estimate anywhere — fall back to the geometric one. Only meaningful for a
    // genuinely live fix, which is the only case that reaches here.
    const nm = greatCircleKm(a.lat, a.lon, arrCoord[0], arrCoord[1]) / 1.852
    etaStr = `${fmtHm(Math.round(nm / a.gs * 60))} ${T('map.until_arrival')}`
  }
  // Fall back to the scheduled time carried on the aircraft when flightStatusRef has
  // nothing — the same chain buildSchedulePopup has always used. Without it the marker
  // popup rendered a bare dash while the schedule panel showed a time for the same flight
  // at the same moment: a flight surfaced as an *aircraft* is excluded from boardDeparted,
  // and boardDeparted is what populates revised_arr_utc.
  const depTimeLocal = popupToLocal(fs?.actual_dep_utc ?? fs?.revised_dep_utc ?? fs?.scheduled_dep_utc ?? null, depOffset, dep ?? 'DAM')
                    || (a.dep_time_utc ? schedToLocal(a.dep_time_utc, depOffset) : '')
  // arrISO above, not a second chain — this is the value the countdown is measured against.
  const arrTimeLocal = popupToLocal(arrISO, arrOffset, arr ?? 'DAM')
                    || (a.arr_time_utc ? schedToLocal(a.arr_time_utc, arrOffset) : '')

  // `before` puts the gap on the side facing the number, and the margin is logical: the
  // physical one put the space on the badge's outer edge under RTL, leaving it touching the
  // time it belongs to. dir=ltr keeps the sign attached to its digits — bidi otherwise
  // throws a leading + to the far end of the token.
  const delayBadge = (min: number | null | undefined) => min != null && Math.abs(min) >= 2
    ? `<span dir="ltr" style="display:inline-flex;background:#fef3c7;color:#92400e;font-size:10px;font-weight:700;padding:2px 5px;border-radius:99px;line-height:1.4;flex-shrink:0">${RTL() ? `<span>د</span><span>${Math.abs(min)}</span><span>${min > 0 ? '+' : '-'}</span>` : `${min > 0 ? '+' : ''}${min}m`}</span>`
    : ''

  /*
   * How far it still has to go, under the bar that shows how far it has come.
   *
   * Beneath rather than beside the altitude and speed, because those describe the aircraft and
   * this describes the journey — it belongs to the bar, not to the telemetry. Beneath rather than
   * above it because the line above is the countdown, and the two would compete: same information,
   * different units, stacked either side of the thing they both measure reads as a pair rather
   * than a repetition.
   *
   * Great-circle to the arrival airport, so it is a floor and not a promise wherever the routing
   * bends — and the same measurement the final ring is tested against, so the line cannot disagree
   * with the behaviour underneath it.
   *
   * Guarded exactly as the telemetry line is, and for the same reason: never while a position is
   * projected, never once the signal has dropped, never after it is down. `a.lat` is then the last
   * place we saw it, and a distance computed from that reads as current when it is not.
   *
   * Suppressed inside the final ring too. That is the one place it would be most useful and least
   * true: at 3 km a fix half a minute old is wrong by two of them, which is most of what is left,
   * and «نقترب من المدرج» is already saying the same thing without pretending to precision.
   */
  const kmToArr = (arrCoord && typeof a.lat === 'number' && typeof a.lon === 'number')
    ? greatCircleKm(a.lat, a.lon, arrCoord[0], arrCoord[1])
    : null
  const onFinal = kmToArr !== null && kmToArr < FINAL_RING_KM

  const distStr = (!projected && !lostAt && !arrived && kmToArr !== null && !onFinal)
    ? `${T('label.distance_left')}: ${Math.round(kmToArr).toLocaleString('en-US')} ${T('unit.km')}`
    : ''

  const progressHtml = progressBarHtml(dep, arr, fraction, etaStr, distStr)

  const timesHtml = (depTimeLocal || arrTimeLocal)
    ? `<div style="display:flex;background:#1f2937;padding:11px 14px">
        <div style="flex:1;text-align:start">
          <div style="font-size:9px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:${RTL() ? 'normal' : '0.6px'};margin-bottom:3px">${T('label.departure')}</div>
          <div style="display:flex;align-items:baseline;gap:7px">
            <span style="font-size:20px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums">${depTimeLocal || '—'}</span>${delayBadge(fs?.dep_delay_min)}
          </div>
        </div>
        <div style="flex:1;text-align:end">
          <div style="font-size:9px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:${RTL() ? 'normal' : '0.6px'};margin-bottom:3px">${T('label.arrival')}</div>
          <div style="display:flex;align-items:baseline;justify-content:flex-end;gap:7px">
            ${delayBadge(fs?.arr_delay_min ?? schedArrDeltaMin(a.arr_time_utc, arrISO))}<span style="font-size:20px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums">${arrTimeLocal || '—'}</span>
          </div>
        </div>
      </div>`
    : ''

  // Same clock as the arrival column directly above it. This was toLocaleTimeString(),
  // i.e. the *viewer's* zone, so a single card carried three unlabelled zones — departure
  // in the origin's, arrival in the destination's, this one in the reader's. On a mostly
  // diaspora audience that also made a signal-lost stamp read as later than the arrival
  // time beside it.
  const lostLocal = lostAt ? popupToLocal(new Date(lostAt).toISOString(), arrOffset, arr ?? 'DAM') : ''
  // Suppressed once it is down: "⚠ signal lost 05:58" under an Arrived badge reads as a fault,
  // when in fact the flight finished normally and only our view of it ended early.
  const lostLine = lostAt && !projected && !arrived
    ? `<div style="color:#ef4444;font-size:11px;padding:5px 14px;text-align:center">⚠ ${T('map.signal_lost')} ${lostLocal}</div>`
    : ''
  const drLine = projected && lostAt
    ? `<div style="color:#9ca3af;font-size:10px;padding:2px 14px 6px;text-align:center">${T('map.dead_reckoning')} ${lostLocal}</div>`
    : ''

  /*
   * Altitude and speed, and only while we actually hold a fix — the app's rule, and its reasoning
   * carries over unchanged: these must never appear for a flight being projected along a stored
   * route, because the numbers would be invented and a reader has no way to tell an invented
   * 34,000 ft from a measured one. buildSchedulePopup, which draws exactly those flights, does
   * not get this line at all.
   *
   * Nor after the signal drops: `a.alt_baro` is then the last altitude we saw, and under a
   * "signal lost" badge it reads as current. Nor once it is down.
   *
   * Digits stay Latin via toLocaleString('en-US') — the house rule wherever a number carries
   * meaning — and only the unit is translated.
   */
  /*
   * Inside the last ten kilometres, say where it is rather than what it was doing.
   *
   * At 134 knots that ring takes about two and a half minutes to cross and the map polls every
   * ten seconds, so a printed figure describes a moment already gone. ABY433 on 15 Aug read
   * "2,500 ft · 134 kt" fifteen seconds before touchdown — measured, current when taken, and
   * wrong by the time anyone read it. The values below it were 65, then 22, then 20 on the
   * rollout, and none of them could ever appear: the flight was Arrived by the next poll and an
   * arrival leaves the map.
   *
   * Ten kilometres because that is the reader's ask and it matches the geometry — beyond it a
   * ten-second lag is a few hundred feet and reads fine; inside it the aircraft is landing.
   */
  // kmToArr and onFinal are measured once, further up, where the distance line under the bar
  // first needs them. This used to declare its own `arrCoords` beside the `arrCoord` already in
  // scope — two names, one lookup, and a standing invitation to change one and not the other.
  const liveDetail = (!projected && !lostAt && !arrived && onFinal)
    ? T('map.approaching_runway')
    : (!projected && !lostAt && !arrived
      && typeof a.alt_baro === 'number' && a.alt_baro > 0)
    ? [
        `${T('label.altitude')}: ${a.alt_baro.toLocaleString('en-US')} ${T('unit.ft')}`,
        typeof a.gs === 'number' && a.gs > 0
          ? `${T('label.speed')}: ${Math.round(a.gs).toLocaleString('en-US')} ${T('unit.kts')}`
          : null,
      ].filter(Boolean).join(' · ')
    : ''
  /*
   * No dir override. It carried dir="ltr" so the digits would stay put — which they do anyway,
   * a number being laid out left-to-right inside an RTL paragraph without being told. What the
   * override actually did was pin the whole line left-to-right on an Arabic page, so a reader
   * scanning right-to-left met "قدم · 454 عقدة 35,000" instead of "35,000 قدم · 454 عقدة": each
   * value separated from its own unit and attached to the next one.
   *
   * The same override, for the same wrong reason, scrambled the board's meta strip on 13 Aug.
   */
  // Back to 14px: the distance that briefly made this line a third too long now lives under the
  // progress bar, so altitude and speed have the room they always had.
  const liveLine = liveDetail
    ? `<div style="color:#9ca3af;font-size:10.5px;padding:3px 14px 7px;text-align:center">${liveDetail}</div>`
    : ''
  const photoHtml = photoUrl
    ? `<img src="${photoUrl}" style="width:100%;height:110px;object-fit:cover;display:block">`
    : ''

  return `<div dir="${RTL() ? 'rtl' : 'ltr'}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;width:280px">
    ${photoHtml}
    <div style="display:flex;align-items:flex-start;gap:11px;padding:13px 13px 8px">
      ${logoHtml}
      <div style="flex:1;min-width:0;text-align:start">
        <div style="font-size:14px;font-weight:700;color:#f9fafb;line-height:1.25">${alName}</div>
        <div style="font-size:12px;color:#9ca3af;margin-top:2px">${identityLine(flightNum, callsign)}</div>
      </div>
      <span style="background:${statusBg};color:${statusFg};font-size:10px;font-weight:600;padding:3px 8px;border-radius:99px;flex-shrink:0;margin-top:1px">${statusLabel}</span>
    </div>
    ${progressHtml}${timesHtml}${liveLine}${lostLine}${drLine}
  </div>`
}

/**
 * Minutes an arrival differs from its scheduled time — negative when early.
 *
 * Computed here because neither source the popups reach for is ever populated:
 * scheduled_arr_utc is only carried forward from an existing entry and never set, and
 * arr_delay_min is never derived in the API at all. So the badge could not appear, and the
 * map card showed a bare arrival time while the flight board showed the same arrival with
 * its variance beside it.
 *
 * The scheduled time is a bare HH:MM, so the day is chosen as whichever puts it nearest the
 * actual arrival — otherwise an overnight leg reads as a 24-hour delay.
 */
function schedArrDeltaMin(arrTimeUtc: string | null | undefined, arrIso: string | null): number | null {
  if (!arrTimeUtc || !arrIso) return null
  const arrMs = Date.parse(arrIso)
  const [h, m] = arrTimeUtc.split(':').map(Number)
  if (!Number.isFinite(arrMs) || !Number.isFinite(h) || !Number.isFinite(m)) return null

  const base = new Date(arrMs)
  base.setUTCHours(h, m, 0, 0)
  let best = base.getTime()
  for (const shift of [-86_400_000, 86_400_000]) {
    const cand = base.getTime() + shift
    if (Math.abs(cand - arrMs) < Math.abs(best - arrMs)) best = cand
  }
  return Math.round((arrMs - best) / 60_000)
}

function buildSchedulePopup(e: ScheduleEntry, arrived = false, fs?: FlightStatus | null, fraction?: number, photoUrl?: string | null): string {
  const acType  = fs?.aircraft_type ?? null
  const aiata   = airlineIataFor(e.callsign, fs)
  const alName  = airlineNameFor(aiata) ?? (aiata ?? e.callsign)

  // Status badge
  const [statusLabel, statusBg, statusFg] = arrived
    ? [T('status.arrived'), '#1e3a5f', '#60a5fa']
    : fraction != null && fraction > 0.02
      ? [`~ ${T('status.in_air')}`, '#713f12', '#fbbf24']
      : [T('status.scheduled'), '#1c1917', '#a8a29e']

  // Airline logo
  const logoHtml = aiata
    ? `<img src="${airlineLogo(aiata)}"
        style="width:44px;height:44px;border-radius:10px;object-fit:contain;${LOGO_WHITE_BG.has(aiata) ? 'background:#fff;' : ''}padding:4px;flex-shrink:0"
        onerror="this.src='https://images.flightsfrom.com/airlines/100/${aiata}_100px.png';this.onerror=null">`
    : `<div style="width:44px;height:44px;border-radius:10px;background:#1f2937;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:22px">${_apFlag[e.dep_iata] || '✈'}</div>`

  const depOffset = _apOffset[e.dep_iata] ?? 3
  const arrOffset = _apOffset[e.arr_iata] ?? 3

  const depTimeLocal = fs?.actual_dep_utc
    ? popupToLocal(fs.actual_dep_utc, depOffset, e.dep_iata)
    : schedToLocal(e.dep_time_utc, depOffset)
  // Same rule as buildPopup: one resolved arrival instant feeds both the ARRIVAL column and
  // the countdown below. The synthesised leg (actual departure + block time) matters for a
  // delayed flight — without it the column showed the scheduled arrival while the countdown
  // ran to the real one, so the card contradicted itself by exactly the delay.
  // Same chain as buildPopup — see the note there. The two countdowns must agree with each
  // other before either can agree with the phone.
  const bestArrISO   = fs?.actual_arr_utc ?? fs?.eta_stable_utc ?? fs?.revised_arr_utc
    ?? (() => {
      const depMs = Date.parse(fs?.actual_dep_utc ?? '')
      return Number.isFinite(depMs) && e.duration_min > 0
        ? new Date(depMs + e.duration_min * 60_000).toISOString()
        : null
    })()
  const arrTimeLocal = bestArrISO
    ? popupToLocal(bestArrISO, arrOffset, e.arr_iata)
    : schedToLocal(e.arr_time_utc, arrOffset)

  /**
   * Only ever measured against an arrival somebody reported — never against one we invented.
   *
   * bestArrISO falls back to actual_dep + duration_min. That is a projection, not an
   * observation, and its variance from schedule is simply the departure delay restated: the
   * badge is redundant when it happens to be right, and free to be wrong when it is not. A
   * card reading "-246m" beside "Schedule projection · no live signal" is the visible form of
   * that, and the figure corrected itself the moment a real ADS-B arrival appeared.
   *
   * So the projected branch shows the ETA and no badge. An actual or revised arrival still
   * gets one, because then there is something real to compare.
   */
  const observedArrISO = fs?.actual_arr_utc ?? fs?.revised_arr_utc ?? null
  const arrDelayMin = fs?.arr_delay_min
    ?? (fs?.revised_arr_utc && fs?.scheduled_arr_utc
        ? Math.round((new Date(fs.revised_arr_utc).getTime() - new Date(fs.scheduled_arr_utc).getTime()) / 60_000)
        : observedArrISO
          ? schedArrDeltaMin(e.arr_time_utc, observedArrISO)
          : null)

  // `before` puts the gap on the side facing the number, and the margin is logical: the
  // physical one put the space on the badge's outer edge under RTL, leaving it touching the
  // time it belongs to. dir=ltr keeps the sign attached to its digits — bidi otherwise
  // throws a leading + to the far end of the token.
  const delayBadge = (min: number | null | undefined) => min != null && Math.abs(min) >= 2
    ? `<span dir="ltr" style="display:inline-flex;background:#fef3c7;color:#92400e;font-size:10px;font-weight:700;padding:2px 5px;border-radius:99px;line-height:1.4;flex-shrink:0">${RTL() ? `<span>د</span><span>${Math.abs(min)}</span><span>${min > 0 ? '+' : '-'}</span>` : `${min > 0 ? '+' : ''}${min}m`}</span>`
    : ''

  // Route progress bar
  const pct = fraction != null && fraction > 0 && fraction < 1 && !arrived
    ? Math.round(Math.min(fraction, 0.97) * 100)
    : arrived ? 100 : null

  // Countdown to the arrival instant shown above, not to a separately-derived one.
  // `fraction` is clamped to 0.97 for the progress bar, so deriving minutes from it also
  // pinned the countdown at ~3% of block time and it never reached zero.
  // Once down, elapsed time replaces it — same rule as buildPopup.
  const sDepMs = Date.parse(fs?.actual_dep_utc ?? '')
  const sArrMs = Date.parse(fs?.actual_arr_utc ?? '')
  let etaStr = ''
  if (Number.isFinite(sArrMs) && Number.isFinite(sDepMs) && sArrMs > sDepMs) {
    etaStr = `${fmtHm(Math.round((sArrMs - sDepMs) / 60_000))} ${T('label.flown')}`
  } else if (!arrived && bestArrISO) {
    const remMin = Math.round((Date.parse(bestArrISO) - Date.now()) / 60_000)
    if (remMin > 0) etaStr = `${fmtHm(remMin)} ${T('map.until_arrival')}`
  } else if (!arrived && pct != null && pct < 100 && e.duration_min > 0) {
    etaStr = `${fmtHm(Math.round(e.duration_min * (1 - (pct / 100))))} ${T('map.until_arrival')}`
  }

  const progressHtml = progressBarHtml(e.dep_iata, e.arr_iata, pct != null ? pct / 100 : null, etaStr)

  const timesHtml = `<div style="display:flex;background:#1f2937;padding:11px 14px">
    <div style="flex:1;text-align:start">
      <div style="font-size:9px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:${RTL() ? 'normal' : '0.6px'};margin-bottom:3px">${T('label.departure')}</div>
      <div style="display:flex;align-items:baseline;gap:7px">
        <span style="font-size:20px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums">${depTimeLocal}</span>${delayBadge(fs?.dep_delay_min)}
      </div>
    </div>
    <div style="flex:1;text-align:end">
      <div style="font-size:9px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:${RTL() ? 'normal' : '0.6px'};margin-bottom:3px">${T('label.arrival')}</div>
      <div style="display:flex;align-items:baseline;justify-content:flex-end;gap:7px">
        ${delayBadge(arrDelayMin)}<span style="font-size:20px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums">${arrTimeLocal}</span>
      </div>
    </div>
  </div>`

  const photoHtml = photoUrl
    ? `<img src="${photoUrl}" style="width:100%;height:110px;object-fit:cover;display:block">`
    : ''

  const noteHtml = !arrived
    ? `<div style="color:#6b7280;font-size:10px;padding:4px 14px 6px;text-align:center">${T('map.no_signal')}</div>`
    : ''

  return `<div dir="${RTL() ? 'rtl' : 'ltr'}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;width:280px">
    ${photoHtml}
    <div style="display:flex;align-items:flex-start;gap:11px;padding:13px 13px 8px">
      ${logoHtml}
      <div style="flex:1;min-width:0;text-align:start">
        <div style="font-size:14px;font-weight:700;color:#f9fafb;line-height:1.25">${alName}</div>
        <div style="font-size:12px;color:#9ca3af;margin-top:2px">${identityLine(fs?.flight_number, e.callsign)}</div>
      </div>
      <span style="background:${statusBg};color:${statusFg};font-size:10px;font-weight:600;padding:3px 8px;border-radius:99px;flex-shrink:0;margin-top:1px">${statusLabel}</span>
    </div>
    ${progressHtml}${timesHtml}${noteHtml}
  </div>`
}

// ── Component ─────────────────────────────────────────────────────────────────

type TrackedEntry    = { a: Aircraft; lostAt: number; isFr24: boolean }
type KinematicState  = { lat: number; lon: number; gs_kts: number; track_deg: number; captured_at_ms: number }

declare global { interface Window { ReactNativeWebView?: { postMessage(msg: string): void }; __rnDeselect?: () => void } }

function rnPost(msg: object) {
  window.ReactNativeWebView?.postMessage(JSON.stringify(msg))
}

function buildEmbedFlight(callsign: string, se: ScheduleEntry | null, fs: FlightStatus | null, photoUrl?: string | null) {
  const aiata = fs?.airline_iata ?? airlineIataFor(callsign)
  return {
    callsign,
    iata_number:    fs?.flight_number  ?? callsign,
    airline_iata:   aiata,
    airline_name:   airlineNameFor(aiata) ?? null,
    dep_iata:       fs?.dep_iata       ?? se?.dep_iata  ?? null,
    arr_iata:       fs?.arr_iata       ?? se?.arr_iata  ?? null,
    dep_time_utc:   se?.dep_time_utc   ?? null,
    arr_time_utc:   se?.arr_time_utc   ?? null,
    duration_min:   se?.duration_min   ?? null,
    status:         fs?.status         ?? 'En Route',
    actual_dep_utc:  fs?.actual_dep_utc  ?? null,
    actual_arr_utc:  fs?.actual_arr_utc  ?? null,
    revised_dep_utc: fs?.revised_dep_utc ?? null,
    revised_arr_utc: fs?.revised_arr_utc ?? null,
    aircraft_type:   fs?.aircraft_type   ?? null,
    dep_delay_min:   fs?.dep_delay_min   ?? null,
    arr_delay_min:   fs?.arr_delay_min   ?? null,
    photoUrl:        photoUrl           ?? null,
  }
}

// ── Over-Syria geofence ──────────────────────────────────────────────────────
function _raycast(lat: number, lon: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (((yi > lat) !== (yj > lat)) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isInSyria(lat: number, lon: number, geo: any): boolean {
  if (!geo) return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const feat of (geo.features ?? [{ geometry: geo }])) {
    const g = feat.geometry ?? feat
    if (g.type === 'Polygon'      && _raycast(lat, lon, g.coordinates[0]))              return true
    if (g.type === 'MultiPolygon' && g.coordinates.some((p: number[][][]) => _raycast(lat, lon, p[0]))) return true
  }
  return false
}

// Header buttons for the media boxes: sized to the hamburger beside them so the row reads
// as one set of controls rather than two.
const headerActionBtn = (active: boolean): React.CSSProperties => ({
  width: 40, height: 40, borderRadius: 10,
  border: `1px solid ${active ? PANEL.forest : PANEL.border}`,
  background: active ? PANEL.forest : '#FFFFFF',
  color: active ? '#FFFFFF' : PANEL.forest,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', flexShrink: 0, padding: 0,
})

export default function Map({ embed = false, targetFlight, panelOpen }: { embed?: boolean; targetFlight?: string; panelOpen?: boolean }) {
  const mapRef          = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstanceRef  = useRef<any>(null)

  /*
   * Which basemap is showing, and the pieces needed to change it.
   *
   * The kind is mirrored into a ref because the map's init effect runs once and must not re-run
   * when the reader picks a different basemap — tearing down and rebuilding the whole map to
   * change what is underneath it would drop every marker and the open popup with them.
   *
   * Leaflet itself is kept too. It arrives through a dynamic import inside that effect, and the
   * switcher runs long afterwards; re-importing the library to add a tile layer would be absurd.
   */
  const [basemap, setBasemap] = useState<BasemapKind>(() => storedBasemap())
  const [cities, setCities] = useState<boolean>(() => storedCities())
  /*
   * Whether the Cities control can do anything, which is not the same as which basemap was asked
   * for. A vector choice can end as raster — no WebGL, a failed load — and the reader would then
   * be left toggling a checkbox that does nothing. attachBasemap reports that, and the control
   * greys itself out.
   */
  const [citiesAvailable, setCitiesAvailable] = useState(true)
  const citiesRef       = useRef<boolean>(cities)
  const basemapKindRef  = useRef<BasemapKind>(basemap)
  const basemapRef      = useRef<BasemapHandle | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leafletRef      = useRef<any>(null)
  /* The airport-name layer, shown in place of the city labels when those are switched off. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const airportLabelsRef = useRef<any>(null)

  const chooseBasemap = useCallback((kind: BasemapKind) => {
    if (kind === basemapKindRef.current) return
    basemapKindRef.current = kind
    setBasemap(kind)
    storeBasemap(kind)

    const map = mapInstanceRef.current
    const L = leafletRef.current
    // Before the map exists there is nothing to swap; the init effect will read the ref.
    if (!map || !L) return
    // Off before on. attachBasemap's handle tracks the layers actually added rather than the ones
    // requested — a vector choice can end as raster — so this removes whatever is really there.
    basemapRef.current?.remove()
    setCitiesAvailable(kind === 'vector')
    basemapRef.current = attachBasemap(L, map, kind, {
      cities: citiesRef.current,
      onFallback: () => setCitiesAvailable(false),
    })
  }, [])

  const chooseCities = useCallback((on: boolean) => {
    citiesRef.current = on
    setCities(on)
    storeCities(on)
    // Straight at the live basemap: hiding a label layer is not worth rebuilding a map for.
    basemapRef.current?.setCities(on)

    /*
     * The airport names take the cities' place rather than joining them.
     *
     * Both sets of labels at once is the crowding this control exists to relieve — and the two
     * would collide, since Damascus the city and مطار دمشق sit within a few kilometres.
     */
    const map = mapInstanceRef.current
    const labels = airportLabelsRef.current
    if (map && labels) {
      if (on) map.removeLayer(labels)
      else labels.addTo(map)
    }
  }, [])

  /*
   * Is this map object still the live one, and still attached?
   *
   * The render pass awaits several times — the Leaflet import, then /api/airspace — and the
   * component can unmount during any of them. Unmount runs map.remove(), which tears down the
   * panes and nulls this ref. The `if (!map) return` at the top of the pass only catches an
   * unmount that happened before the ref was read; after that, `map` is a perfectly valid
   * object with no panes left. Adding a layer to it reaches Leaflet's _initIcon, where
   * getPane() returns undefined and appendChild throws.
   *
   * Three users hit exactly that on /board and /map — two on the board's map preview, which
   * mounts and unmounts as the page re-renders while a poll is still in flight.
   *
   * Identity check as well as the pane check: after remove() a stale map can still answer
   * getPane, and it is no longer the one on screen either way.
   */
  const mapAlive = (m: any): boolean =>
    !!m && mapInstanceRef.current === m && !!m.getPane?.('markerPane')

  /**
   * addTo, but only onto a map that can still receive it.
   *
   * Returns the layer regardless so callers keep their reference and need no restructuring.
   * A layer that was not added is inert — Leaflet guards setLatLng and setIcon on a marker
   * with no icon — and the next poll replaces it, if there is a next poll.
   */
  const addToMap = <T extends { addTo: (m: any) => T }>(layer: T, m: any): T => {
    if (mapAlive(m)) layer.addTo(m)
    return layer
  }
  // Markers keyed by CALLSIGN (not hex) — one entry per flight
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef      = useRef<Record<string, any>>({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const linesRef        = useRef<Record<string, any[]>>({})
  // Schedule-based projected markers (key = callsign)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schedMarkersRef = useRef<Record<string, any>>({})
  /** Consecutive polls a ghost's callsign has been missing from the server's payload. */
  const unvouchedRef    = useRef<Record<string, number>>({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schedLinesRef   = useRef<Record<string, any[]>>({})
  /**
   * When each callsign was first seen arrived, and where.
   *
   * The arrival time itself is not enough to rank by: a flight can be declared arrived with no
   * actual_arr_utc at all — TKJ340 into Aleppo on 15 Aug was inferred from its estimate five
   * minutes after the fact, having last been observed 16.6 km out at 8,025 ft. So this records the
   * published time where there is one and the moment we first believed it where there is not,
   * which is the best available answer to "which of these landed most recently".
   *
   * Written once per callsign and never revised: the first sighting is the one that dates the
   * arrival, and letting a later poll overwrite it would keep pushing the same flight to the front
   * of the queue and never let the next one take the airport.
   */
  const arrivedAtRef      = useRef<Record<string, { at: number; arr: string | null }>>({})
  // Last-known state keyed by callsign — replaces hex-keyed lastKnownRef
  const trackedRef        = useRef<Record<string, TrackedEntry>>({})
  const scheduleRef       = useRef<ScheduleEntry[]>([])
  // boardDeparted overrides: effectiveDurationMin is more accurate than stored schedule block time
  const durationOverridesRef = useRef<Record<string, number>>({})
  const routePathsRef     = useRef<Record<string, Waypoint[]>>({})
  const flightStatusRef   = useRef<Record<string, FlightStatus>>({})
  const photoCacheRef     = useRef<Record<string, string | null>>({})
  const photoRequestedRef = useRef<Set<string>>(new Set())
  const selectedCSRef     = useRef<string | null>(null)  // track which callsign is open in native
  const autoOpenDoneRef   = useRef(false)
  const targetFlightRef   = useRef(targetFlight)
  targetFlightRef.current = targetFlight

  /**
   * Does any identifier this aircraft is known by match the selected flight?
   *
   * Comparing against `iata_number` alone silently excluded Fly Cham. The board lists it
   * under its broadcast callsign (FYC489) while the airspace feed carries the ticketed
   * number in `iata_number` (XH489) and the callsign in `flight`, so the equality never
   * held: the plane drew normally but never turned red, never auto-panned and never opened
   * its popup. Every other airline broadcasts what it tickets, which is why it looked
   * intermittent rather than broken.
   */
  const matchesTarget = useCallback((...ids: (string | null | undefined)[]) => {
    const t = targetFlightRef.current?.trim().toUpperCase()
    if (!t) return false
    return ids.some((id) => id?.trim().toUpperCase() === t)
  }, [])
  const highlightedCSRef  = useRef<string | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchUpdateRef    = useRef<(() => Promise<void>) | null>(null)
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isAutoOpenRef     = useRef(false)
  const panelOpenRef      = useRef(panelOpen ?? true)
  panelOpenRef.current    = panelOpen ?? true

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trackLinesRef     = useRef<any[]>([])

  useEffect(() => {
    if (!targetFlight) {
      // Selection cleared from the side panel. Without this the effect simply returned, so
      // the red highlight and the drawn leg stayed on the map with nothing selected.
      highlightedCSRef.current = null
      selectedCSRef.current    = null
      trackLinesRef.current.forEach(l => l.remove())
      trackLinesRef.current = []
      // Re-render: marker colour is decided during the poll, so the red icon only reverts
      // once the markers are rebuilt.
      fetchUpdateRef.current?.()
      return
    }
    autoOpenDoneRef.current = false
    highlightedCSRef.current = null
    setLoading(true)
    fetchUpdateRef.current?.()
    // Fallback: clear spinner after 3s if flight isn't found in the feed
    const t = setTimeout(() => setLoading(false), 3000)
    return () => clearTimeout(t)
  }, [targetFlight])
  // Last confirmed ADS-B lat/lon per callsign — kept alive through stale hand-off
  // so the schedule overlay GPS floor still works after trackedRef is cleared.
  const lastADSBPosRef    = useRef<Record<string, { lat: number; lon: number; lostAt: number }>>({})
  // Last kinematic state per callsign — kept for schedule-overlay DR fallback.
  const kinematicStateRef = useRef<Record<string, KinematicState>>({})
  // One FlightPredictor per callsign — handles hybrid DR + smooth recovery for ADS-B entries.
  const predictorRef      = useRef<Record<string, FlightPredictor>>({})
  // Path-anchored trackers, one per airborne flight, driving the animation loop.
  const storeRef          = useRef<TrackerStore>(new TrackerStore())
  /**
   * Flights held at their last real fix this cycle.
   *
   * They keep feeding the tracker — withholding them dropped it, and the next poll built a
   * fresh one seeded from elapsed time, which jumped the aircraft onto the schedule position
   * and back again as the pin engaged and disengaged. The tracker keeps running; it just
   * does not own the marker while the pin holds.
   */
  const pinnedRef = useRef<Set<string>>(new Set())
  const storeInputsRef    = useRef<FlightInput[]>([])
  const lastFedPosRef     = useRef<Record<string, string>>({})

  const [error, setError]     = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadMs, setLoadMs]   = useState(0)
  const firstLoadDoneRef      = useRef(false)

  // ── Over-Syria feature state ─────────────────────────────────────────────
  const attrCleanupRef = useRef<(() => void) | null>(null)
  const [overSyriaOn, setOverSyriaOn]       = useState(false)

  // Media boxes on phones. Their triggers move into the site header — the only chrome on
  // this page that is not covering the map — so the map surface stays clear until you ask
  // for something. The buttons are portalled rather than passed down as props: the header
  // is rendered by the page, well outside this tree, and threading two booleans and their
  // setters up through it would put map state in a component with no other use for it.
  const [videoOpen, setVideoOpen] = useState(false)
  const [photoOpen, setPhotoOpen] = useState(false)
  const [isPhone, setIsPhone] = useState(false)
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null)

  useEffect(() => {
    const mq = window.matchMedia(PHONE_MQ)
    const apply = () => setIsPhone(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  // The header mounts before this map does, but look it up after paint rather than during
  // render so a slower first paint cannot leave the buttons homeless.
  useEffect(() => { setActionSlot(document.getElementById('sn-page-actions')) }, [])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const syriaGeoRef                          = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const overSyriaMarkersRef                  = useRef<Record<string, any>>({})

  useEffect(() => {
    if (!loading) return
    const t = setInterval(() => setLoadMs(ms => ms + 100), 100)
    return () => clearInterval(t)
  }, [loading])

  // ── Map init ────────────────────────────────────────────────────────────────
  useEffect(() => { loadGeoData() }, [])

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return
    import('leaflet').then(L => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (mapRef.current as any)._leaflet_id
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (L.Icon.Default.prototype as any)._getIconUrl
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      })
      const map = L.map(mapRef.current!, {
        center: [33.0, 40.0], zoom: 6,
        maxBoundsViscosity: 0,
        zoomControl: false,
        /*
         * Quarter-step zoom so fitBounds can actually land on the bounds.
         *
         * With whole levels it rounds down to the next one that fits, which on most phone
         * widths threw away a lot of slack and opened wider than asked for. zoomDelta stays 1
         * so the +/- buttons still move a full level at a time.
         */
        zoomSnap: 0.25,
        zoomDelta: 1,
      })
      /*
       * Open on the whole network, not on Syria alone.
       *
       * zoom 6 over Damascus cut off both ends of the map's own traffic — Istanbul to the
       * north-west and Dubai to the south-east are where most of it comes from, and a reader
       * arriving at Track should see the aircraft, not have to pinch out to find them. These
       * are the bounds the embed already used; they hold IST at 41.3N and DXB at 25.2N.
       *
       * Fitted once the map is ready rather than inline: fitBounds needs the container's real
       * size, and called straight after the constructor it can run before layout has given it
       * one — in which case it silently keeps the constructor's zoom 6 over Damascus.
       */
      map.whenReady(() => {
        map.invalidateSize()
        // Hugging Istanbul (41.3N, 28.8E) and Dubai (25.2N, 55.4E) rather than sitting well
        // outside them — the first pass read as too far out.
        map.fitBounds([[24, 28], [42.5, 56.5]], { padding: [8, 8] })
      })

      // Leaflet prepends its own "Leaflet |" credit. It is MIT-licensed and asks for no
      // attribution, so that part is courtesy rather than obligation — dropping it takes
      // roughly a quarter off the strip's width. What remains is the wording OSM and CARTO
      // actually require, which is the floor short of hiding it behind a tap-to-expand
      // control.
      map.attributionControl.setPrefix(false)
      // Top-left, out of the way of everything: the flight strip owns the bottom edge on
      // Side depends on width, because the free corner does. On phones the media buttons
      // moved to the site header, so the top-right is empty and the top-left is wanted for
      // the flight-count badge. On desktop the media boxes still hold the top-right, so the
      // credit stays left. Position is not something the licence dictates — only that the
      // credit stays visible.
      const attrMq = window.matchMedia(PHONE_MQ)
      const placeAttribution = () => map.attributionControl.setPosition(attrMq.matches ? 'topright' : 'topleft')
      placeAttribution()
      attrMq.addEventListener('change', placeAttribution)
      attrCleanupRef.current = () => attrMq.removeEventListener('change', placeAttribution)
      // Added before the tile layer so it lands above the attribution in the bottom-right
      // corner. Desktop-only, but gated in CSS rather than on innerWidth — a one-shot
      // width read here can fire before the viewport settles and silently drop the control.
      if (!embed) {
        L.control.zoom({ position: 'bottomright' }).addTo(map)
      }
      /*
       * The basemap, and the reader can change it — see lib/basemap-attach.
       *
       * Replaces CARTO's raster tiles, which since 26 Aug carry an "API KEY REQUIRED" watermark
       * baked into a subset of the PNGs: no error, no failed request, just the words across the
       * map at some zooms. lib/basemap-style says why a free CARTO key was not the answer.
       *
       * The handle is kept so a switch can take this basemap off before putting the next one on.
       * L is kept for the same reason — the switcher runs long after this effect has finished,
       * and re-importing Leaflet to add a tile layer would be absurd.
       */
      leafletRef.current = L
      basemapRef.current = attachBasemap(L, map, basemapKindRef.current, {
        cities: citiesRef.current,
        onFallback: () => setCitiesAvailable(false),
      })

      mapInstanceRef.current = map

      if (!embed) {
        map.on('popupopen', () => {
          if (isAutoOpenRef.current) {
            isAutoOpenRef.current = false
            if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current)
            autoCloseTimerRef.current = setTimeout(() => map.closePopup(), 10_000)
          } else {
            if (autoCloseTimerRef.current) { clearTimeout(autoCloseTimerRef.current); autoCloseTimerRef.current = null }
          }
        })
      }

      if (embed) {
        map.on('click', () => {
          selectedCSRef.current = null
          rnPost({ type: 'DESELECT' })
        })
        // Called by native dismiss — keeps selectedCSRef in sync so photo re-fire is suppressed
        window.__rnDeselect = () => { selectedCSRef.current = null }
      }

      // ── Syrian airport circles ─────────────────────────────────────────────
      /*
       * Every airport the map marks, with its code attached rather than trailing in a comment.
       *
       * The codes used to live only in `// DAM` notes beside each pair, which was fine while
       * nothing needed them. The airport labels do — see AIRPORT_LABELS below — and a name looked
       * up from a comment is not a thing.
       */
      const SERVICED: [number, number, string][] = [
        // Syrian airports
        [33.4114, 36.5156, 'DAM'],
        [36.1807, 37.2244, 'ALP'],
        [35.4011, 35.9488, 'LTK'],
        [35.2854, 40.1760, 'DEZ'],
        // Active destinations (last 7 days)
        [38.2924, 27.1570, 'ADB'],
        [31.7226, 35.9930, 'AMM'],
        [52.3086, 4.7639, 'AMS'],
        [24.4330, 54.6511, 'AUH'],
        [33.2626, 44.2346, 'BGW'],
        [26.4712, 49.7979, 'DMM'],
        [25.2731, 51.6081, 'DOH'],
        [25.2528, 55.3644, 'DXB'],
        [36.2376, 43.9631, 'EBL'],
        [40.1281, 32.9951, 'ESB'],
        [41.2608, 28.7418, 'IST'],
        [21.6796, 39.1565, 'JED'],
        [29.2267, 47.9689, 'KWI'],
        [23.5933, 58.2844, 'MCT'],
        [32.8942, 13.2759, 'MJI'],
        [44.5711, 26.0850, 'OTP'],
        [24.9578, 46.6989, 'RUH'],
        [40.8986, 29.3092, 'SAW'],
        [25.3285, 55.5172, 'SHJ'],
        [51.2895, 6.7668, 'DUS'],
        [52.3667, 13.5033, 'BER'],
        [36.8987, 30.7999, 'AYT'],
      ]

      /*
       * Airport names, shown only when the reader has turned the city labels OFF.
       *
       * Turning cities off leaves a map of borders and water with nothing named on it, which is
       * quiet but disorienting — and the things worth naming on a flight tracker are the airports,
       * not the towns. So the two swap: lose the cities, gain the airports.
       *
       * Leaflet markers rather than a MapLibre layer, deliberately. The names come from our own
       * geo-data — the localised ones the popups and the panel already use — rather than from
       * whatever OSM happens to carry, so they read the same everywhere and follow the page's
       * language. Drawing them in Leaflet also keeps them independent of which basemap is
       * underneath, which matters the day this is offered on the raster one too.
       *
       * airportLabelFor gives مطار دمشق in Arabic and the bare code in English — which is right
       * both ways round: an English reader scans for DAM, and دمشق alone would not say airport.
       */
      /*
       * Two airports serving one city share a name, so the code breaks the tie.
       *
       * Istanbul has both IST and SAW, and in Arabic airportLabelFor returns مطار إسطنبول for
       * each — two identical labels a few centimetres apart, naming different airports. English
       * never had the problem because it shows the code, which is unique by construction.
       *
       * Only the duplicates are disambiguated: appending the code to every label would clutter
       * the twenty-odd that were already unambiguous to fix the two that were not.
       */
      // Plain objects, not Maps: inside THIS file `Map` is the React component, so `new Map()`
      // resolves to the component and fails to compile. A rare collision, and a confusing error.
      const nameCounts: Record<string, number> = {}
      for (const [, , iata] of SERVICED) {
        const name = airportLabelFor(iata)
        nameCounts[name] = (nameCounts[name] ?? 0) + 1
      }
      const labelFor: Record<string, string> = {}
      for (const [, , iata] of SERVICED) {
        const name = airportLabelFor(iata)
        labelFor[iata] = nameCounts[name] > 1 ? `${name} (${iata})` : name
      }

      const airportLabels = L.layerGroup()
      for (const [lat, lon, iata] of SERVICED) {
        airportLabels.addLayer(L.marker([lat, lon], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: '',
            // Wide and centred on the circle, with the text pushed below it: a label sitting on
            // top of its own marker is unreadable against the dashed ring.
            iconSize: [120, 34],
            iconAnchor: [60, -6],
            html: `<div style="text-align:center;font:600 10px/1.2 ui-sans-serif,system-ui,sans-serif;
                     color:#8a3b3b;text-shadow:0 0 3px #f4f5f0,0 0 3px #f4f5f0,0 0 3px #f4f5f0;
                     white-space:nowrap">${labelFor[iata] ?? iata}</div>`,
          }),
        }))
      }
      airportLabelsRef.current = airportLabels
      // Cities on is the default, so the airport names start hidden and appear when they are
      // switched off. citiesRef rather than state: this runs once, inside the init effect.
      if (!citiesRef.current) airportLabels.addTo(map)

      for (const [lat, lon] of SERVICED) {
        L.circle([lat, lon], {
          radius:      8000,
          color:       '#e53e3e',
          fillColor:   '#e53e3e',
          fillOpacity: 0.08,
          weight:      2,
          dashArray:   '4 4',
          opacity:     0.75,
          interactive: false,
        }).addTo(map)
      }

      // Syria boundary overlay
      fetch('/syria_adm0.geojson')
        .then(r => r.json())
        .then(geo => {
          L.geoJSON(geo, {
            style: {
              color:       '#4a7a30',
              weight:      1.5,
              opacity:     0.6,
              fillColor:   '#4a7a30',
              fillOpacity: 0.06,
              interactive: false,
            },
          }).addTo(map)
        })
        .catch(() => {})
    })
    return () => { attrCleanupRef.current?.(); mapInstanceRef.current?.remove(); mapInstanceRef.current = null }
  }, [])

  // ── Load route paths once on mount ─────────────────────────────────────────
  useEffect(() => {
    fetch('/api/routes')
      .then(r => r.json())
      .then(d => {
        if (!d.ok) return
        const rec: Record<string, Waypoint[]> = {}
        for (const p of d.paths as { dep_iata: string; arr_iata: string; waypoints: Waypoint[] }[]) {
          rec[`${p.dep_iata}|${p.arr_iata}`] = p.waypoints
        }
        routePathsRef.current = rec
      })
      .catch(() => {})
  }, [])

  // ── Poll loop ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const fetchAndUpdate = async () => {
      storeInputsRef.current = []
      pinnedRef.current = new Set()
      const L   = (await import('leaflet')).default
      const map = mapInstanceRef.current
      if (!map) return

      const now = Date.now()

      // Draw completed + remaining route lines for the tracked flight
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      /**
       * Draw the half of the leg that is not obvious from context.
       *
       * An aircraft approaching Damascus is plainly going to Damascus; what the click is
       * really asking is where it came from. So an arrival into one of our airports draws
       * back to its origin, and a departure draws ahead to its destination. A leg between
       * two of our own airports counts as a departure, which is how it reads on the board.
       */
      const drawTrackRoute = (marker: any, depIata: string | null, arrIata: string | null) => {
        trackLinesRef.current.forEach(l => l.remove())
        trackLinesRef.current = []
        const pos      = marker.getLatLng()
        const inbound  = !!arrIata && HOME_AIRPORTS.has(arrIata)
                      && !(depIata && HOME_AIRPORTS.has(depIata))
        const otherEnd = inbound ? depIata : arrIata
        const coord    = otherEnd ? _apCoords[otherEnd] : null
        if (coord) {
          trackLinesRef.current.push(
            L.polyline([[pos.lat, pos.lng], [coord[0], coord[1]]], {
              color: '#054239', weight: 1.5, opacity: 0.55, dashArray: '6 9',
            }).addTo(map)
          )
        }
      }

      // ── 1. Fetch feed + update trackedRef (keyed by callsign) ─────────────
      const freshCallsigns = new Set<string>()  // callsigns in THIS cycle's live feed
      /*
       * Callsigns the server is vouching for in THIS poll — a live fix, or a board row it still
       * considers en route.
       *
       * flightStatusRef is a write-only accumulator keyed by callsign: entries go in and never
       * leave. That is fine while the server keeps talking about a flight, and wrong the moment it
       * stops. KNE592 landed at 15:32:58; the server carried it for thirty minutes and then, quite
       * correctly, went quiet. The client's last word on it was "Departed", so the schedule overlay
       * went on projecting it — and the projection is allowed to run two hours past its arrival
       * before it expires, which is why it sat parked at Jeddah at 17:13 with a popup reading
       * "~ في الجو" while the board and the side panel both said Arrived.
       *
       * The panel was right because it reads the board directly. The map was reasoning from a
       * memory nobody had corrected. So a ghost now requires the server to vouch for it right now;
       * absence is treated as information, which it is — the server drops a flight precisely
       * because it has arrived. Safe because a failed poll returns above without reaching here, so
       * "the server said nothing" can never mean "we could not ask".
       */
      const vouchedCallsigns = new Set<string>()

      /*
       * Has this callsign arrived, according to the freshest thing we hold?
       *
       * The stored Aircraft is a snapshot of the poll that last carried a position, and a flight
       * stops being carried at almost exactly the moment it lands — so that snapshot is precisely
       * the copy that predates the arrival. QTR411 landed at 17:42:48; the server had it in
       * boardDeparted as `arrived` within seconds, while the aircraft object frozen in trackedRef
       * still said `departed`, and the marker read a stale field and stayed on the map.
       *
       * flightStatusRef first, because boardDeparted keeps refreshing it after the fixes stop.
       * The snapshot is only a fallback, for a flight the board has never mentioned.
       *
       * This is the third shape of one mistake today — the ghost's own memory, then the aircraft
       * snapshot here. Anything that answers "what is true now" from a stored copy is wrong by
       * construction, because the copy is taken before the thing we care about happens.
       */
      const arrivedNow = (cs: string, a?: Aircraft | null) => {
        const fs = flightStatusRef.current[cs]
        return hasArrived({
          status:         fs?.status ?? canonicalStatus(a?.board_status),
          actual_arr_utc: fs?.actual_arr_utc ?? a?.actual_arr_utc ?? null,
        })
      }

      /*
       * One arrival stays on the map per airport: the last one in, until the next lands or an hour
       * passes.
       *
       * Arrivals were removed from the map outright on 14 Aug, and that was right about the pile —
       * half an hour of ARRIVED tags stacked over Damascus, which a fan, an offset along the route
       * and a badge all failed to make readable. It was wrong about the last one. "What just landed
       * here" is a question about now, and it has exactly one answer per airport, so it costs one
       * marker rather than a heap.
       *
       * Ranked on when we first believed the arrival, not on the published time, because a third of
       * Aleppo's arrivals are never published at all. Older entries are pruned here rather than
       * left to accumulate across a session.
       */
      for (const [cs, rec] of Object.entries(arrivedAtRef.current)) {
        if (now - rec.at > ARRIVED_HOLD_MS) delete arrivedAtRef.current[cs]
      }

      const noteArrived = (cs: string, arrIata: string | null, publishedArrUtc?: string | null) => {
        if (arrivedAtRef.current[cs]) return
        arrivedAtRef.current[cs] = { at: Date.parse(publishedArrUtc ?? '') || now, arr: arrIata }
      }

      /*
       * Is this callsign the one its airport is currently holding?
       *
       * Scans rather than reading a precomputed winner, so the answer cannot depend on whether a
       * flight happened to be noted before or after the table was built — the two render passes
       * walk different collections in different orders, and a table built between them would let
       * the same flight win on one path and lose on the other.
       *
       * The tie-break on callsign exists because two arrivals can land in the same second when both
       * are inferred from estimates, and without it neither would hold the airport: each would see
       * the other as not-older and stand down.
       */
      const holdsAirport = (cs: string) => {
        const rec = arrivedAtRef.current[cs]
        if (!rec?.arr || now - rec.at > ARRIVED_HOLD_MS) return false
        for (const [other, r] of Object.entries(arrivedAtRef.current)) {
          if (other === cs || r.arr !== rec.arr || now - r.at > ARRIVED_HOLD_MS) continue
          if (r.at > rec.at || (r.at === rec.at && other < cs)) return false
        }
        return true
      }

      try {
        const res  = await fetch('/api/airspace')
        const data = await res.json()
        if (!data.ok) {
          const warn = data.warn ?? 'feed error'
          reportHandledError(`airspace not ok: ${warn}`, { endpoint: '/api/airspace' })
          return
        }

        if (data.from_db) {
          // DB fallback: seed trackedRef without overwriting existing entries
          for (const a of data.aircraft as Aircraft[]) {
            const cs = (a.flight ?? '').trim()
            if (!cs || !a.board_match) continue
            if (!trackedRef.current[cs]) {
              const lostAt = a.seen_at ? new Date(a.seen_at).getTime() : now - 5 * 60_000
              trackedRef.current[cs] = { a, lostAt, isFr24: false }
            }
          }
          setError('Live feed down — showing last known positions')
        } else {
          const fr24Ts: number = data.fr24Ts ?? 0

          // Process each aircraft into trackedRef — board_match=true only
          for (const a of data.aircraft as Aircraft[]) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const isFr24  = (a as any).fr24 === true
            const isStale = a.stale === true
            const cs = (a.flight ?? '').trim()
            if (!cs || !a.board_match) continue

            if (isStale) {
              // DB stale row: preserve existing lostAt; never overwrite an FR24 entry
              const prev = trackedRef.current[cs]
              if (!prev?.isFr24) {
                const lostAt = prev?.lostAt || (a.seen_at ? new Date(a.seen_at).getTime() : now - 5 * 60_000)
                trackedRef.current[cs] = { a, lostAt, isFr24: false }
              }
            } else if (isFr24) {
              // FR24 cache: lostAt = fr24Ts so DR advances between 5-min refreshes.
              // Don't overwrite a fresher OpenSky entry — that would give it a stale
              // lostAt and immediately trigger the FR24_HAND_OFF_MS deletion.
              // A poller fix carries its own capture time; fr24Ts is the batch-wide
              // fallback for sources that only stamp the whole response.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const fixAt      = Date.parse(a.fix_at ?? '') || 0
              const fr24LostAt = fixAt || fr24Ts || now - 30_000
              const prevFr24   = trackedRef.current[cs]
              if (!prevFr24 || prevFr24.lostAt <= fr24LostAt) {
                trackedRef.current[cs] = { a, lostAt: fr24LostAt, isFr24: true }
              }
            } else {
              /*
               * Take the row. No arbitration — there is nothing to arbitrate.
               *
               * Two heuristics have stood here and both failed the same way, on descent, because
               * that is the only time these numbers visibly change:
               *
               *   gs >= prev.gs   an arriving aircraft slows, so every fix after the fastest was
               *                   refused. The snapshot froze at cruise: 484 kt, 36,025 ft, shown
               *                   as the present tense twenty-five minutes later.
               *
               *   newer fix_at    fix_at and seen_at are absent on live rows — measured 3 of 3 —
               *                   so a fresh fix scores 0 and loses to any stored timestamp. Same
               *                   freeze, different arithmetic. That one was mine, and it shipped
               *                   as the fix for the first.
               *
               * The premise was wrong both times. The airspace route already emits one position
               * per callsign — measured, no duplicates in a payload — so there is no competing row
               * to choose between, and the newest response is by definition the best thing we
               * know. Anything that can reject it can only make the map older than the server.
               */
              /*
               * The row is still the best position we hold, but "we hold a position" and "we are
               * hearing from this aircraft" are different claims, and this line used to make both.
               *
               * The server keeps listing an aircraft after its fixes stop, so lostAt stayed 0 and
               * the card stayed green — altitude, speed and distance all presented as current from
               * a fix minutes old. TKJ340 into Aleppo on 15 Aug: last heard 04:42:33 at 16.6 km and
               * 8,025 ft, dropped by the server at 04:47:50, and for those five minutes and
               * seventeen seconds the popup showed a live badge over frozen numbers while the
               * aircraft descended and landed.
               *
               * Nothing new is drawn for this case — the projected state already exists and is
               * already right. Only its trigger moves: from "the server gave up on it" to "the data
               * stopped arriving", which is the thing a reader actually cares about.
               *
               * lostAt is the moment of the last fix, not now, so the dead-reckoning stamp names
               * when we really lost it. TKJ340's card would have read 7:42 rather than 7:47.
               */
              const ageMs = typeof a.fix_age_s === 'number' ? a.fix_age_s * 1000 : 0
              if (ageMs > STALE_FIX_MS) {
                const lostFixAt = now - ageMs
                /*
                 * onSignalLostAt, not onSignalLoss: the loss is already in the past and the
                 * predictor has to be told both instants to ease the correction in.
                 *
                 * The first attempt at this called onSignalLoss and shipped a defect — the
                 * prediction was 150 s of travel ahead of the drawn marker and arrived in one
                 * frame, which on FYC762 at 369 kt was about 15 km. The prediction was right;
                 * presenting the whole correction at once was not.
                 *
                 * Called every poll while the fix stays stale. The predictor's own guard makes
                 * that safe and is the only guard — an outer check on lostAt would be a second
                 * copy of the same rule, free to disagree with it.
                 */
                predictorRef.current[cs]?.onSignalLostAt(lostFixAt, now)
                trackedRef.current[cs] = { a, lostAt: lostFixAt, isFr24: false }
              } else {
                trackedRef.current[cs] = { a, lostAt: 0, isFr24: false }
                freshCallsigns.add(cs)  // record as seen in this live cycle
              }
            }
          }

          // Seed flightStatusRef from board_match aircraft with lifecycle timestamps
          for (const a of data.aircraft as Aircraft[]) {
            if (!a.board_match || (!a.actual_dep_utc && !a.actual_arr_utc)) continue
            const cs = (a.flight ?? '').trim()
            if (!cs) continue
            vouchedCallsigns.add(cs)
            const existing = flightStatusRef.current[cs]
            const legDep   = a.actual_dep_utc ?? existing?.actual_dep_utc ?? null
            const arrUtc   = a.actual_arr_utc ?? carryArrival(existing?.actual_arr_utc, legDep)
            flightStatusRef.current[cs] = {
              callsign:          cs,
              // From the resolved arrival, not the incoming one — otherwise a flight whose
              // arrival is carried forward reads "Departed" while its card reads "Arrived".
              //
              // Falling back to the server's verdict rather than to a bare 'Departed'. The literal
              // was the map's own guess, and once the client's arrival stopwatch went it was the
              // only thing left saying anything — so a flight the server had already called
              // Arrived, with no published arrival time to carry, stayed airborne here forever.
              status:            arrUtc ? 'Arrived' : (canonicalStatus(a.board_status) || 'Departed'),
              actual_dep_utc:    legDep,
              actual_arr_utc:    arrUtc,
              scheduled_dep_utc: existing?.scheduled_dep_utc ?? null,
              // Same leg test as the arrival: these feed the card's ARRIVAL column and its
              // countdown, so a stale one is just as visible as a stale "Arrived".
              scheduled_arr_utc: carryArrival(existing?.scheduled_arr_utc, legDep),
              revised_dep_utc:   existing?.revised_dep_utc   ?? null,
              // From the aircraft first, not only carried forward. boardDeparted is the only
              // other source of this field and it excludes any flight we hold a fix for, so a
              // live aircraft never had one — and buildPopup then fell back to departure plus
              // scheduled duration. RJ435 read ARRIVAL 07:40 in the popup against 07:13 on the
              // side card, which is the revised time the board had all along.
              revised_arr_utc:   a.revised_arr_utc ?? carryArrival(existing?.revised_arr_utc, legDep),
              // Carried alongside, never synthesised: this field means "the service damped this",
              // and inventing one locally would put the client back in the damping business,
              // which is the whole thing being removed.
              eta_stable_utc:    a.eta_stable_utc ?? existing?.eta_stable_utc ?? null,
              dep_delay_min:     a.dep_delay_min ?? existing?.dep_delay_min ?? null,
              arr_delay_min:     arrUtc ? existing?.arr_delay_min ?? null : null,
              aircraft_reg:      a.r ?? existing?.aircraft_reg   ?? null,
              aircraft_type:     a.t ?? existing?.aircraft_type  ?? null,
              flight_number:     a.iata_number ?? existing?.flight_number ?? null,
              dep_iata:          a.dep_iata ?? existing?.dep_iata ?? null,
              arr_iata:          a.arr_iata ?? existing?.arr_iata ?? null,
              airline_iata:      a.airline_iata ?? existing?.airline_iata ?? null,
            }
          }

          // Inject boardDeparted into scheduleRef + flightStatusRef
          for (const bd of (data.boardDeparted ?? []) as {
            callsign: string; dep_iata: string; arr_iata: string
            duration_min: number
            dep_time_utc: string | null; arr_time_utc: string | null
            actual_dep_utc: string | null; actual_arr_utc: string | null
            revised_arr_utc: string | null
            eta_stable_utc: string | null
            status: string | null
            iata_number: string; dep_delay_min: number | null; airline_iata: string | null
            aircraft_reg: string | null; aircraft_type: string | null
          }[]) {
            const { callsign: cs, dep_iata, arr_iata, duration_min, dep_time_utc, arr_time_utc,
                    actual_dep_utc, actual_arr_utc, revised_arr_utc, eta_stable_utc,
                    status: boardStatus,
                    iata_number, dep_delay_min, airline_iata,
                    aircraft_reg, aircraft_type } = bd
            if (!cs || !dep_iata || !arr_iata) continue
            vouchedCallsigns.add(cs)
            const existing = flightStatusRef.current[cs]
            // Synthesize estimated arrival from actual_dep + duration when no explicit revised/actual arr
            const effectiveDep = actual_dep_utc ?? existing?.actual_dep_utc ?? null
            const estimatedArr = !actual_arr_utc && !revised_arr_utc && effectiveDep && duration_min > 0
              ? new Date(new Date(effectiveDep).getTime() + duration_min * 60_000).toISOString()
              : null
            const carriedArr = actual_arr_utc ?? carryArrival(existing?.actual_arr_utc, effectiveDep)
            flightStatusRef.current[cs] = {
              callsign:          cs,
              // Same fallback as the seed above: the server's word when we hold no arrival time
              // of our own. This is the path FAD742 came in on.
              status:            carriedArr ? 'Arrived' : (canonicalStatus(boardStatus) || 'Departed'),
              actual_dep_utc:    effectiveDep,
              actual_arr_utc:    carriedArr,
              scheduled_dep_utc: existing?.scheduled_dep_utc ?? null,
              scheduled_arr_utc: carryArrival(existing?.scheduled_arr_utc, effectiveDep),
              revised_dep_utc:   existing?.revised_dep_utc   ?? null,
              revised_arr_utc:   revised_arr_utc ?? estimatedArr ?? carryArrival(existing?.revised_arr_utc, effectiveDep),
              // Not falling back to estimatedArr. That is the client's own arithmetic — the
              // fallback belongs in the chain that reads this, not in the field that says the
              // server stabilised something.
              eta_stable_utc:    eta_stable_utc ?? existing?.eta_stable_utc ?? null,
              dep_delay_min:     dep_delay_min ?? existing?.dep_delay_min ?? null,
              arr_delay_min:     carriedArr ? existing?.arr_delay_min ?? null : null,
              aircraft_reg:      aircraft_reg  ?? existing?.aircraft_reg  ?? null,
              aircraft_type:     aircraft_type ?? existing?.aircraft_type ?? null,
              flight_number:     iata_number,
              dep_iata, arr_iata, airline_iata,
            }
            // Cache the effective duration so schedule reloads can re-apply it
            durationOverridesRef.current[cs] = duration_min
            // Day-aware on the write side too, or the board's times would be applied to
            // whichever row happened to come first — quite possibly another day's.
            const existingSched    = pickSchedule(scheduleRef.current, cs, now)
            const existingSchedIdx = existingSched ? scheduleRef.current.indexOf(existingSched) : -1
            if (existingSchedIdx === -1) {
              scheduleRef.current.push({
                callsign: cs, dep_iata, arr_iata,
                // The board's own scheduled times, which it has always known — this entry no
                // longer invents any. Still nullable: a flight the board has no timetable for
                // reports null, and null is measured against by nothing.
                dep_time_utc, arr_time_utc,
                duration_min, days_of_week: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
              })
            } else {
              // boardDeparted carries effectiveDurationMin (actual dep → revised arr when known),
              // which is more accurate than the stored schedule block time — update it.
              scheduleRef.current[existingSchedIdx] = {
                ...scheduleRef.current[existingSchedIdx],
                duration_min,
                // The board is filed against the day actually being flown; a stored row is a
                // weekly pattern and can be the wrong day's. Prefer the board where it has an
                // answer, keep what is stored where it does not.
                dep_time_utc: dep_time_utc ?? scheduleRef.current[existingSchedIdx].dep_time_utc,
                arr_time_utc: arr_time_utc ?? scheduleRef.current[existingSchedIdx].arr_time_utc,
              }
            }
          }

          // feeds_live === false means every ADS-B circle failed and the aircraft above
          // are last-known positions, not live fixes. Worth saying out loud rather than
          // presenting hours-old positions as current.
          setError(
            data.feeds_live === false ? 'Live feed down — showing last known positions'
            : data.warn                ? 'Feed degraded'
            : null
          )
        }
      } catch (e) {
        /*
         * Recorded, never shown.
         *
         * A user photographed "TypeError: Failed to fetch" on this map and sent it in. Nothing
         * was wrong: iOS Safari freezes a backgrounded tab and aborts its in-flight requests,
         * so the rejection surfaces when the page resumes. The map recovers on the next tick
         * and the user was shown a red banner about the browser's own housekeeping.
         *
         * A single failed poll is not news either way. The map keeps the last positions, and on
         * a phone network a dropped request every so often is ordinary. It goes to
         * /admin/errors, where a real outage shows up as a rate rather than as one person
         * noticing a banner.
         */
        if (document.visibilityState === 'visible') {
          reportHandledError(`map poll: ${String(e)}`, {
            endpoint: '/api/airspace',
            tracked: Object.keys(trackedRef.current).length,
          })
        }
      }

      // ── 2. Mark callsigns that dropped from the live feed ─────────────────
      // Any non-FR24 entry with lostAt=0 that wasn't in freshCallsigns this cycle
      // gets lostAt=now — signal was lost.
      for (const [cs, entry] of Object.entries(trackedRef.current)) {
        if (!entry.isFr24 && entry.lostAt === 0 && !freshCallsigns.has(cs)) {
          trackedRef.current[cs] = { ...entry, lostAt: now }
          predictorRef.current[cs]?.onSignalLoss(now)
        }
      }

      /*
       * 2b. Position and milestone logging removed on 15 Aug 2026.
       *
       * This POSTed every fresh fix to /api/signal-log, which wrote flight_position_log and
       * flight_signal_log. Both are retired: positions come from fr24_live_position, written
       * server-side by the harvester, and the two consumers of the milestone table — carry-over's
       * airborne gate and the no-activity report — now read `flight` instead.
       *
       * What that logging actually bought was measured before it went: five consecutive hours on
       * 14 Aug with no rows written because nobody had the map open, and a verdict of "did not
       * fly" recorded against RB445, which had departed at 20:28 and landed at 22:02.
       */
      if (freshCallsigns.size > 0) {
        // Capture kinematic state for dead reckoning after signal loss.
        // Only from fresh live ADS-B (not FR24 cache, not stale DB rows).
        for (const cs of freshCallsigns) {
          const entry = trackedRef.current[cs]
          if (!entry || entry.lostAt !== 0 || entry.isFr24) continue
          const a = entry.a
          if (typeof a.gs !== 'number' || a.gs <= 50) continue
          if (!a.dep_iata || !a.arr_iata) continue
          kinematicStateRef.current[cs] = {
            lat:           a.lat,
            lon:           a.lon,
            gs_kts:        a.gs,
            track_deg:     typeof a.track === 'number' ? a.track : 0,
            captured_at_ms: now,
          }

          // Feed the predictor with this fresh fix.
          if (!predictorRef.current[cs]) predictorRef.current[cs] = new FlightPredictor()
          const predPos: PredictorLivePos = {
            lat:         a.lat,
            lon:         a.lon,
            track_deg:   bestHeading(a),   // cross-checks true_heading vs track
            gs_kts:      a.gs,
            vs_fpm:      0,   // ADS-B feed does not provide vs directly
            altitude_ft: typeof a.alt_baro === 'number' ? a.alt_baro : null,
          }
          predictorRef.current[cs].onLive(predPos, now)
        }
      }

      // ── 3. Render tracked entries (live + stale/DR) ────────────────────────
      const realCallsigns = new Set<string>()   // suppresses schedule markers
      const STALE_HAND_OFF_MS = 3 * 60_000
      const FR24_HAND_OFF_MS  = 30 * 60_000

      /*
       * Record every arrival before any of them is judged.
       *
       * Noting them inside the render loop below would make the winner depend on iteration order:
       * an older arrival evaluated first would find no newer one recorded yet, hold the airport,
       * and only stand down on the next poll — ten seconds of two markers on the same runway.
       */
      for (const [cs, entry] of Object.entries(trackedRef.current)) {
        if (!arrivedNow(cs, entry.a)) continue
        const fs = flightStatusRef.current[cs]
        noteArrived(cs, fs?.arr_iata ?? entry.a.arr_iata ?? null,
                    fs?.actual_arr_utc ?? entry.a.actual_arr_utc)
      }

      for (const [cs, entry] of Object.entries(trackedRef.current)) {
        const { a, lostAt, isFr24 } = entry

        /*
         * An arrival leaves the map here too, not only on the schedule overlay.
         *
         * I removed arrivals from the ghost path and reported the map clear of them. It was not:
         * that only covered flights we had lost. An aircraft still transmitting on the apron kept
         * its live marker, faded, with an ARRIVED tag — SYR504 sat at Damascus at 17:30 having
         * landed at 17:20, on a fix nine minutes old, while the panel had already moved it to the
         * وصلت list. When I checked earlier and saw no arrived markers, no landed aircraft happened
         * to be in the feed; I read luck as proof.
         *
         * The position is real, which is what made this easy to leave alone. But a real position
         * on a stand is not what a map of flights is for, and the reader was told twice — the tag
         * and the list — that the flight was over.
         *
         * Except the newest one, as of 15 Aug: each airport keeps its most recent arrival for an
         * hour or until the next lands. That is one marker per airport rather than the pile this
         * paragraph was written about, and it answers a question the list cannot — where the
         * aircraft that just landed here actually is.
         */
        if (arrivedNow(cs, a) && !holdsAirport(cs)) {
          markersRef.current[cs]?.remove(); delete markersRef.current[cs]
          linesRef.current[cs]?.forEach((l: any) => l.remove()); delete linesRef.current[cs]  // eslint-disable-line
          continue
        }

        // TTL expiry — Syria flights: 6 h
        if (!isFr24 && lostAt > 0 && now - lostAt > STALE_TTL_SYRIA_MS) {
          markersRef.current[cs]?.remove(); delete markersRef.current[cs]
          linesRef.current[cs]?.forEach((l: any) => l.remove()); delete linesRef.current[cs]  // eslint-disable-line
          delete trackedRef.current[cs]; delete predictorRef.current[cs]
          continue
        }

        // FR24 hand-off: after 30 min let the schedule overlay take over,
        // unless the predictor says the plane is still airborne (routeFraction < 0.99).
        if (isFr24 && now - lostAt > FR24_HAND_OFF_MS) {
          const predFr24  = predictorRef.current[cs]
          const predAlive = predFr24 && predFr24.getDisplay(now).routeFraction < 0.99
          if (!predAlive) {
            markersRef.current[cs]?.remove(); delete markersRef.current[cs]
            linesRef.current[cs]?.forEach((l: any) => l.remove()); delete linesRef.current[cs]  // eslint-disable-line
            delete trackedRef.current[cs]; delete predictorRef.current[cs]
            continue
          }
        }

        // Record last ADS-B lat/lon before any hand-off clears trackedRef,
        // so the schedule overlay GPS floor still works after hand-off.
        if (!isFr24) lastADSBPosRef.current[cs] = { lat: a.lat, lon: a.lon, lostAt }

        // ADS-B stale hand-off: let schedule overlay take over only when the predictor
        // believes the flight has arrived (routeFraction ≥ 0.99). Confidence level alone
        // is not a valid trigger — GPS jamming in the region causes multi-hour outages
        // while the plane is still airborne, so we must trust route progress over confidence.
        if (!isFr24 && lostAt > 0 && now - lostAt > STALE_HAND_OFF_MS) {
          const sched = pickSchedule(scheduleRef.current, cs, now)
          const pred  = predictorRef.current[cs]
          // Hand off only when no predictor, or predictor says the plane has arrived.
          const canHandOff = !pred || pred.getDisplay(now).routeFraction >= 0.99
          if (canHandOff && sched && isFlightActiveNow(sched.dep_time_utc, sched.arr_time_utc, sched.days_of_week, now) !== null) {
            markersRef.current[cs]?.remove(); delete markersRef.current[cs]
            linesRef.current[cs]?.forEach((l: any) => l.remove()); delete linesRef.current[cs]  // eslint-disable-line
            delete trackedRef.current[cs]; delete predictorRef.current[cs]
            continue
          }
        }

        const isLive     = lostAt === 0 && !isFr24
        const elapsed    = lostAt > 0 ? now - lostAt : 0
        const hub        = markerHub(a.dep_iata, a.arr_iata)
        const isOnGround = (a.alt_baro === 'ground' || (typeof a.alt_baro === 'number' && a.alt_baro < 500))
                        && (typeof a.gs === 'number' ? a.gs < 50 : false)

        let dispLat = a.lat, dispLon = a.lon, dispTrack = bestHeading(a)
        let projected = false, arrSnapped = false

        // ── Arrival-window expiry ─────────────────────────────────────────────
        {
          const bufMs = (a.stale || isOnGround) ? 90 * 60_000 : 15 * 60_000
          let expired = false
          // Board confirmed arrival — expire after 30 min regardless of ADS-B state.
          // flightStatusRef is updated from boardDeparted which reflects FR24 status;
          // a.actual_arr_utc (last live snapshot) may still be null when the plane just landed.
          const fsArrUtc = flightStatusRef.current[cs]?.actual_arr_utc
          if (fsArrUtc && now - new Date(fsArrUtc).getTime() > ARRIVED_HOLD_MS) {
            expired = true
          } else if (a.actual_dep_utc && a.duration_min) {
            const expectedArrMs = new Date(a.actual_dep_utc).getTime() + a.duration_min * 60_000
            // Once past expected arrival, use 90 min grace regardless of a.stale/isOnGround —
            // without route_master in scheduleRef the stale hand-off may not have fired yet
            // (boardDeparted has a 60s server cache), so keep the entry alive long enough for
            // the schedule overlay to take over rather than expiring after only 15 min.
            const effectiveBufMs = now > expectedArrMs ? 90 * 60_000 : bufMs
            const schedExpired = now - expectedArrMs > effectiveBufMs
            // If the predictor is still confident the plane was recently seen on ADS-B —
            // trust that over a potentially-wrong duration_min estimate.
            const predArr = predictorRef.current[cs]
            const predConf = predArr?.confidence(now)
            const predStillFlying = predConf === 'excellent' || predConf === 'high' || predConf === 'medium'
            expired = schedExpired && !predStillFlying
          } else if (a.arr_time_utc) {
            const d = new Date(now)
            const nowSec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()
            const [ah, am] = a.arr_time_utc.split(':').map(Number)
            const sinceArr = (nowSec - (ah * 3600 + am * 60) + 86400) % 86400
            if (sinceArr > bufMs / 1000 && sinceArr < 22 * 3600) {
              const se_ = pickSchedule(scheduleRef.current, cs, now)
              const activeFrac = se_ ? isFlightActiveNow(se_.dep_time_utc, se_.arr_time_utc, se_.days_of_week, now) : null
              const schedInactive = !(activeFrac !== null && activeFrac <= 1.0)
              const predArr2  = predictorRef.current[cs]
              const predConf2 = predArr2?.confidence(now)
              const predFlying2 = predConf2 === 'excellent' || predConf2 === 'high' || predConf2 === 'medium'
              expired = schedInactive && !predFlying2
            }
          }
          if (expired) {
            markersRef.current[cs]?.remove(); delete markersRef.current[cs]
            linesRef.current[cs]?.forEach((l: any) => l.remove()); delete linesRef.current[cs]  // eslint-disable-line
            delete trackedRef.current[cs]; delete predictorRef.current[cs]
            continue
          }
        }

        // ── Path-based DR for non-live entries ────────────────────────────────
        if (!isLive) {
          const schedEntry = pickSchedule(scheduleRef.current, cs, now)
          const pathKey = schedEntry
            ? `${schedEntry.dep_iata}|${schedEntry.arr_iata}`
            : (a.dep_iata && a.arr_iata ? `${a.dep_iata}|${a.arr_iata}` : '')
          const wps = pathKey ? routePathsRef.current[pathKey] : undefined
          const durationMin = schedEntry?.duration_min ?? a.duration_min ?? 0
          const fraction = (() => {
            if (a.actual_dep_utc && durationMin > 0) {
              const f = (now - new Date(a.actual_dep_utc).getTime()) / (durationMin * 60_000)
              if (f >= 0) return f
            }
            if (!schedEntry) return null
            return isFlightActiveNow(schedEntry.dep_time_utc, schedEntry.arr_time_utc, schedEntry.days_of_week, now)
          })()

          if (wps?.length && fraction !== null) {
            const clampedF = Math.min(0.97, fraction)
            const [timeLat, timeLon] = interpolatePath(wps, clampedF)

            const fsDr = flightStatusRef.current[cs]
            const depUtcDr = a.actual_dep_utc ?? fsDr?.actual_dep_utc ?? null
            const actualDepFrac = (depUtcDr && durationMin > 0)
              ? Math.max(0, Math.min(0.97, (now - new Date(depUtcDr).getTime()) / (durationMin * 60_000)))
              : null

            let useF = clampedF

            if (fraction > 1.0) {
              // Post-arrival freeze
              if (actualDepFrac !== null && actualDepFrac < 1.0) {
                useF = actualDepFrac
                const [adfLat, adfLon] = interpolatePath(wps, useF)
                dispLat = adfLat; dispLon = adfLon
                dispTrack = bearingFromPath(wps, useF)
              } else {
                const arrC2 = schedEntry ? _apCoords[schedEntry.arr_iata] : null
                if (arrC2) { dispLat = arrC2[0]; dispLon = arrC2[1] }
                else { dispLat = timeLat; dispLon = timeLon }
                dispTrack = bearingFromPath(wps, Math.min(1, fraction))
                arrSnapped = true
              }
            } else if (isFr24) {
              // FR24: prefer predictor (if fed from a prior live fix) over flat-Earth DR
              const predFr24Render = predictorRef.current[cs]
              if (predFr24Render && predFr24Render.confidence(now) !== 'very_low') {
                const depI2 = schedEntry?.dep_iata ?? a.dep_iata ?? ''
                const arrI2 = schedEntry?.arr_iata ?? a.arr_iata ?? ''
                const dc2   = _apCoords[depI2]
                const ac3   = _apCoords[arrI2]
                if (dc2 && ac3) {
                  predFr24Render.setContext({
                    dep_coords:        dc2,
                    arr_coords:        ac3,
                    actual_dep_utc_ms: depUtcDr ? new Date(depUtcDr).getTime() : null,
                    duration_ms:       durationMin > 0 ? durationMin * 60_000 : null,
                    sched_dep_utc_ms:  null,
                    waypoints:         wps ?? [],
                  })
                }
                const displayFr24 = predFr24Render.getDisplay(now)
                dispLat   = displayFr24.lat
                dispLon   = displayFr24.lon
                dispTrack = displayFr24.track_deg
                projected = displayFr24.isEstimated
              } else {
              // Flat-Earth kinematic DR for FR24 entries (no prior live fix available)
              let drLat = a.lat, drLon = a.lon, drValid = false
              if (typeof a.gs === 'number' && a.gs > 50 && typeof a.track === 'number') {
                ;[drLat, drLon] = projectPosition(a.lat, a.lon, a.track, a.gs, elapsed)
                const arrC2  = schedEntry ? _apCoords[schedEntry.arr_iata] : null
                const distFix = arrC2 ? greatCircleKm(a.lat,  a.lon,  arrC2[0], arrC2[1]) : 0
                const distDR  = arrC2 ? greatCircleKm(drLat, drLon, arrC2[0], arrC2[1]) : 0
                drValid = !arrC2 || distDR <= distFix + 20
              }

              if (drValid) {
                const drPathF = nearestPathFraction(wps, drLat, drLon)
                if (actualDepFrac !== null && drPathF < actualDepFrac) {
                  useF = actualDepFrac
                  const [pl, pln] = interpolatePath(wps, useF)
                  dispLat = pl; dispLon = pln
                  dispTrack = bearingFromPath(wps, useF)
                } else {
                  dispLat = drLat; dispLon = drLon
                  dispTrack = a.track ?? 0
                }
              } else {
                // Path-following fallback — walk forward from nearest route point
                const liveF = nearestPathFraction(wps, a.lat, a.lon)
                const pathBearingAtLive = bearingFromPath(wps, liveF)
                const trackDiff = typeof a.track === 'number'
                  ? Math.abs(((a.track - pathBearingAtLive) + 180) % 360 - 180)
                  : 0
                if (trackDiff >= 90) {
                  dispLat = a.lat; dispLon = a.lon; dispTrack = a.track ?? 0
                } else {
                  let elapsedFrac = 0
                  if (durationMin > 0) {
                    elapsedFrac = elapsed / (durationMin * 60_000)
                  } else {
                    const depC2 = _apCoords[schedEntry?.dep_iata ?? a.dep_iata ?? ''] ?? null
                    const arrC2 = _apCoords[schedEntry?.arr_iata ?? a.arr_iata ?? ''] ?? null
                    if (depC2 && arrC2) {
                      const routeKm = greatCircleKm(depC2[0], depC2[1], arrC2[0], arrC2[1])
                      if (routeKm > 0) {
                        const speedKts = (a.gs && a.gs > 50) ? a.gs : 450
                        elapsedFrac    = speedKts * 1.852 * (elapsed / 3_600_000) / routeKm
                      }
                    }
                  }
                  useF = Math.min(0.97, Math.max(liveF + elapsedFrac, actualDepFrac ?? 0))
                  const [pathLat, pathLon] = interpolatePath(wps, useF)
                  dispLat = pathLat; dispLon = pathLon
                  dispTrack = bearingFromPath(wps, useF)
                }
              }
              } // end flat-Earth else
            } else {
              // ADS-B stale: use predictor for hybrid DR + smooth recovery.
              const pred = predictorRef.current[cs]
              if (pred) {
                const depI = schedEntry?.dep_iata ?? a.dep_iata ?? ''
                const arrI = schedEntry?.arr_iata ?? a.arr_iata ?? ''
                const dc   = _apCoords[depI]
                const ac2  = _apCoords[arrI]
                if (dc && ac2) {
                  pred.setContext({
                    dep_coords:        dc,
                    arr_coords:        ac2,
                    actual_dep_utc_ms: depUtcDr ? new Date(depUtcDr).getTime() : null,
                    duration_ms:       durationMin > 0 ? durationMin * 60_000 : null,
                    sched_dep_utc_ms:  null,
                    waypoints:         wps ?? [],
                  })
                }
                const display = pred.getDisplay(now)
                dispLat   = display.lat
                dispLon   = display.lon
                dispTrack = display.track_deg
                // Override the projected flag based on predictor state
                projected = display.isEstimated
              } else {
                // Predictor not yet set up — fallback to kinematic DR
                if (typeof a.gs === 'number' && a.gs > 50 && typeof a.track === 'number') {
                  const [drLat, drLon] = projectPosition(a.lat, a.lon, a.track, a.gs, elapsed)
                  const drF = nearestPathFraction(wps, drLat, drLon)
                  if (drF >= useF) {
                    dispLat = drLat; dispLon = drLon; dispTrack = a.track
                  } else {
                    dispLat = timeLat; dispLon = timeLon
                    dispTrack = bearingFromPath(wps, useF)
                  }
                } else {
                  dispLat = timeLat; dispLon = timeLon
                  dispTrack = bearingFromPath(wps, useF)
                }
              }
            }
            projected = true
          } else if (schedEntry && fraction !== null && fraction > 1.0) {
            const arrC = _apCoords[schedEntry.arr_iata]
            if (arrC) { dispLat = arrC[0]; dispLon = arrC[1]; arrSnapped = true; projected = true }
          } else if (a.gs && a.track &&
              (schedEntry == null || fraction !== null ||
               (typeof a.alt_baro === 'number' && a.alt_baro > 2_000))) {
            // Fallback: kinematic dead-reckoning (no waypoints available)
            // Use _apCoords (full DB airport map) so European destinations like DUS are included
            const arrAp  = schedEntry?.arr_iata ?? a.arr_iata ?? null
            const depAp  = schedEntry?.dep_iata ?? a.dep_iata ?? null
            const arrApC = arrAp ? _apCoords[arrAp] : null
            const depApC = depAp ? _apCoords[depAp] : null
            // If the last fix was within 15 km of the arrival airport, snap immediately
            if (arrApC && greatCircleKm(a.lat, a.lon, arrApC[0], arrApC[1]) < 15) {
              dispLat = arrApC[0]; dispLon = arrApC[1]; arrSnapped = true; projected = true
            } else {
              const projDistKm = a.gs * 1.852 * (elapsed / 3_600_000)
              const destDists  = [arrApC, depApC]
                .filter((c): c is [number, number] => !!c)
                .map(c => greatCircleKm(a.lat, a.lon, c[0], c[1]))
              const minDestKm = destDists.length ? Math.min(...destDists) : Infinity
              if (projDistKm < minDestKm) {
                const [pLat, pLon] = projectPosition(a.lat, a.lon, a.track, a.gs, elapsed)
                dispLat = pLat; dispLon = pLon; projected = true
              } else {
                // Snap to arrival if heading toward it, otherwise departure
                const snapC = arrApC ?? depApC
                if (snapC) {
                  const bearingToAp = (Math.atan2(
                    (snapC[1] - a.lon) * Math.cos(a.lat * Math.PI / 180),
                    snapC[0] - a.lat
                  ) * 180 / Math.PI + 360) % 360
                  const headingDiff = Math.abs(((a.track - bearingToAp) + 180) % 360 - 180)
                  if (headingDiff < 90) { dispLat = snapC[0]; dispLon = snapC[1]; arrSnapped = !!arrApC }
                }
              }
            }
          }
        }

        // On-ground: pin to arrival airport
        if (isOnGround && !arrSnapped) {
          const se_ = pickSchedule(scheduleRef.current, cs, now)
          const arrIata_ = se_?.arr_iata ?? a.arr_iata ?? null
          const arrC_ = arrIata_ ? _apCoords[arrIata_] : null
          if (arrC_) { dispLat = arrC_[0]; dispLon = arrC_[1]; arrSnapped = true; projected = true }
        }

        // Confirmed arrival snap
        if (!arrSnapped) {
          const fsFix = flightStatusRef.current[cs]
          if (fsFix?.actual_arr_utc && now - new Date(fsFix.actual_arr_utc).getTime() < 4 * 3_600_000) {
            const seFix = pickSchedule(scheduleRef.current, cs, now)
            const arrFix = (seFix ? _apCoords[seFix.arr_iata] : null)
                        ?? (fsFix.arr_iata ? _apCoords[fsFix.arr_iata] : null)
                        ?? (a.arr_iata    ? _apCoords[a.arr_iata]    : null)
            if (arrFix) { dispLat = arrFix[0]; dispLon = arrFix[1]; arrSnapped = true }
          }
        }

        // Stale un-projected: park pre-departure or post-arrival
        if (a.stale && !projected) {
          const se = pickSchedule(scheduleRef.current, cs, now)
          // Times are required here, not just an inactive result: isFlightActiveNow returns
          // null both for "not flying now" and for "no timetable at all", and only the first
          // has hours to reason about.
          if (se && se.dep_time_utc && se.arr_time_utc
              && isFlightActiveNow(se.dep_time_utc, se.arr_time_utc, se.days_of_week, now) === null) {
            const toSec2 = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 3600 + m * 60 }
            const d2 = new Date(now)
            const todayDay2 = ['sun','mon','tue','wed','thu','fri','sat'][d2.getUTCDay()]
            const nowSec2 = d2.getUTCHours() * 3600 + d2.getUTCMinutes() * 60 + d2.getUTCSeconds()
            const depSec2 = toSec2(se.dep_time_utc)
            const arrSec2 = toSec2(se.arr_time_utc)
            const sinceArr2 = (nowSec2 - arrSec2 + 86400) % 86400
            if (se.days_of_week.includes(todayDay2)) {
              if (nowSec2 < depSec2) {
                const depC = _apCoords[se.dep_iata]
                if (depC) { dispLat = depC[0]; dispLon = depC[1] }
              } else if (sinceArr2 > 0 && sinceArr2 <= 90 * 60) {
                const arrC = _apCoords[se.arr_iata]
                if (arrC) { dispLat = arrC[0]; dispLon = arrC[1]; arrSnapped = true }
              }
            }
          }
        }

        /*
         * Callsign, then where it is heading.
         *
         * The destination and not the other end: an aircraft over Saudi labelled "إلى: دمشق" is
         * telling you it is inbound, which is the thing worth knowing at a glance. It does mean
         * every inbound marker says Damascus, which is repetition — see the note at the call site
         * in the schedule overlay.
         */
        const fsCs          = flightStatusRef.current[cs]
        const destLine      = destinationLine(a.dep_iata ?? fsCs?.dep_iata ?? null,
                                              a.arr_iata ?? fsCs?.arr_iata ?? null)
        const staleLabel    = arrSnapped ? `${cs}\nARRIVED`
                            : destLine   ? `${cs}\n${destLine}`
                            : cs
        const isEstimated   = projected && !arrSnapped
        const isHighlighted = highlightedCSRef.current === cs
        const icon    = planeIcon(L, dispTrack, true, arrSnapped, staleLabel, hub, isEstimated, isHighlighted ? '#ef4444' : undefined)
        const fsDr    = flightStatusRef.current[cs]
        const regDr   = fsDr?.aircraft_reg ?? a.r ?? null
        const photoDr = regDr ? photoCacheRef.current[regDr] ?? null : null
        const popup   = buildPopup(a, lostAt > 0 ? lostAt : undefined, projected && !isLive, fsDr, photoDr)

        // Smooth position blend for FR24 entries to avoid marker jumps
        if (isFr24 && !arrSnapped && markersRef.current[cs]) {
          const p = markersRef.current[cs].getLatLng()
          const BLEND = 0.55
          dispLat = p.lat + BLEND * (dispLat - p.lat)
          dispLon = p.lng + BLEND * (dispLon - p.lng)
        }

        // Feed the path tracker. Only a fix and an arrival estimate go in; where the
        // aircraft is drawn comes from the animation loop, not from here.
        if (RAF_MOTION && !arrSnapped) {
          const dep = a.dep_iata ?? null
          const arr = a.arr_iata ?? null
          const depC = dep ? _apCoords[dep] : null
          const arrC = arr ? _apCoords[arr] : null
          const depAt = a.actual_dep_utc ? Date.parse(a.actual_dep_utc) : null
          if (depC && arrC && depAt && Number.isFinite(depAt)) {
            const wps = dep && arr ? routePathsRef.current[`${dep}|${arr}`] : undefined
            // Offer a fix only when the reported position actually moved, otherwise the
            // same stale position would keep dragging the rate down every poll.
            const posKey = `${a.lat},${a.lon}`
            const moved  = lastFedPosRef.current[cs] !== posKey
            if (moved) lastFedPosRef.current[cs] = posKey
            storeInputsRef.current.push({
              callsign:       cs,
              variants:       wps && wps.length >= 2 ? [wps] : [],
              dep_coords:     depC,
              arr_coords:     arrC,
              departed_at_ms: depAt,
              /*
               * The revised arrival first, exactly as the schedule overlay below already does.
               *
               * This path only ever used the scheduled block, and a short leg that leaves early is
               * where that falls apart. RJ440 on 15 Aug is filed DAM–AMM 01:55–02:45, a 50-minute
               * block; it left at 01:27 and flew it in 28. At 01:51 the predictor had it 24 minutes
               * into 50 — 49% along a 194 km route, some 95 km from Damascus — while the aircraft
               * was 13 km from Amman on final. The marker sat near the border, and the popup beside
               * it read "1 minute to arrival", because the countdown was reading the revised time
               * the predictor was ignoring.
               *
               * The fix offered below corrects the rate, but it cannot outvote a duration that is
               * nearly twice the truth for the whole flight.
               */
              eta_ms:         (() => {
                const revised = a.revised_arr_utc ? Date.parse(a.revised_arr_utc) : NaN
                if (Number.isFinite(revised)) return revised
                return a.duration_min ? depAt + a.duration_min * 60_000 : null
              })(),
              duration_ms:    (() => {
                const revised = a.revised_arr_utc ? Date.parse(a.revised_arr_utc) : NaN
                if (Number.isFinite(revised) && revised > depAt) return revised - depAt
                return a.duration_min ? a.duration_min * 60_000 : null
              })(),
              fix: (moved && isLive) ? {
                lat: a.lat, lon: a.lon, at_ms: now,
                gs_kts: a.gs ?? null, track_deg: a.track ?? null,
                altitude_ft: typeof a.alt_baro === 'number' ? a.alt_baro : null,
              } : null,
              src: 'live',
            })
          }
        }

        if (markersRef.current[cs]) {
          // The animation loop owns position for flights the tracker manages.
          if (!(RAF_MOTION && storeRef.current.has(cs))) markersRef.current[cs].setLatLng([dispLat, dispLon])
          markersRef.current[cs].setIcon(icon)
          if (!embed) markersRef.current[cs].setPopupContent(popup)
          if (cs === highlightedCSRef.current || cs === selectedCSRef.current) {
            const se_ = pickSchedule(scheduleRef.current, cs, now)
            drawTrackRoute(markersRef.current[cs], se_?.dep_iata ?? a.dep_iata ?? null, se_?.arr_iata ?? a.arr_iata ?? null)
          }
        } else {
          const m = addToMap(L.marker([dispLat, dispLon], { icon }), map)
          if (embed) {
            m.on('click', () => {
              const fs  = flightStatusRef.current[cs]
              const se  = pickSchedule(scheduleRef.current, cs, now)
              const reg = fs?.aircraft_reg ?? a.r ?? null
              const ph  = reg ? photoCacheRef.current[reg] ?? null : null
              selectedCSRef.current = cs
              rnPost({ type: 'SELECT', flight: buildEmbedFlight(cs, se ?? null, fs ?? null, ph) })
            })
          } else {
            m.bindPopup(popup, { className: 'fp-popup', closeButton: false, maxWidth: 300 })
          }
          markersRef.current[cs] = m

          // Auto-pan + open popup for deep-linked flight (new marker)
          if (!embed && !autoOpenDoneRef.current && matchesTarget(a.iata_number, a.flight, cs)) {
            autoOpenDoneRef.current = true
            highlightedCSRef.current = cs
            setLoading(false)
            const capCs = cs; const capDep = a.dep_iata ?? flightStatusRef.current[cs]?.dep_iata ?? null; const capArr = a.arr_iata ?? flightStatusRef.current[cs]?.arr_iata ?? null
            const capTrack = dispTrack; const capLabel = staleLabel; const capHub = hub; const capEst = isEstimated
            setTimeout(() => {
              const mk = markersRef.current[capCs]; const mi = mapInstanceRef.current
              if (mk && mi) { mk.setIcon(planeIcon(L, capTrack, true, false, capLabel, capHub, capEst, '#ef4444')); ((_z) => { const _w = mi.getSize().x; const _off = panelOpenRef.current && _w >= 480 ? Math.min(160, (_w - 320) / 2) : 0; const _p = mi.project(mk.getLatLng(), _z); mi.setView(mi.unproject(_p.subtract(L.point(_off, 0)), _z), _z) })(Math.max(mi.getZoom(), 8)); isAutoOpenRef.current = true; mk.openPopup(); drawTrackRoute(mk, capDep, capArr) }
            }, 300)
          }
        }

        // Auto-open for existing live marker
        if (!embed && !autoOpenDoneRef.current && matchesTarget(a.iata_number, a.flight, cs) && markersRef.current[cs]) {
          autoOpenDoneRef.current = true
          highlightedCSRef.current = cs
          setLoading(false)
          const mk = markersRef.current[cs]; const mi = mapInstanceRef.current
          const dep = a.dep_iata ?? flightStatusRef.current[cs]?.dep_iata ?? null; const arr = a.arr_iata ?? flightStatusRef.current[cs]?.arr_iata ?? null
          mk.setIcon(planeIcon(L, dispTrack, true, false, staleLabel, hub, isEstimated, '#ef4444'))
          if (mk && mi) { ((_z) => { const _w = mi.getSize().x; const _off = panelOpenRef.current && _w >= 480 ? Math.min(160, (_w - 320) / 2) : 0; const _p = mi.project(mk.getLatLng(), _z); mi.setView(mi.unproject(_p.subtract(L.point(_off, 0)), _z), _z) })(Math.max(mi.getZoom(), 8)); isAutoOpenRef.current = true; mk.openPopup(); drawTrackRoute(mk, dep, arr) }
        }

        // Fetch aircraft photo once per registration
        if (regDr && !photoRequestedRef.current.has(regDr)) {
          photoRequestedRef.current.add(regDr)
          const capturedCS     = cs
          const capturedA      = a
          const capturedLostAt = lostAt
          fetch(`/api/photo/${encodeURIComponent(regDr)}`)
            .then(r => r.ok ? r.json() : null)
            .then(photoData => {
              const url: string | null = photoData?.url ?? null
              photoCacheRef.current[regDr] = url
              if (url && markersRef.current[capturedCS]) {
                const fsNow = flightStatusRef.current[capturedCS]
                markersRef.current[capturedCS].setPopupContent(
                  buildPopup(capturedA, capturedLostAt > 0 ? capturedLostAt : undefined, false, fsNow, url)
                )
              }
              if (url && selectedCSRef.current === capturedCS) {
                const fsNow = flightStatusRef.current[capturedCS]
                const seNow = pickSchedule(scheduleRef.current, capturedCS, now) ?? null
                rnPost({ type: 'SELECT', flight: buildEmbedFlight(capturedCS, seNow, fsNow ?? null, url) })
              }
            })
            .catch(() => { photoCacheRef.current[regDr] = null })
        }

        linesRef.current[cs]?.forEach((l: any) => l.remove())  // eslint-disable-line
        linesRef.current[cs] = []
        realCallsigns.add(cs)
      }

      // Remove markers for callsigns no longer in trackedRef
      for (const cs of Object.keys(markersRef.current)) {
        if (!trackedRef.current[cs]) {
          markersRef.current[cs]?.remove(); delete markersRef.current[cs]
          linesRef.current[cs]?.forEach((l: any) => l.remove()); delete linesRef.current[cs]  // eslint-disable-line
        }
      }

      // ── 4. Schedule overlay (ESTIMATED / no signal) ───────────────────────
      /*
       * Tally, once per callsign, how many consecutive polls the server has said nothing about it.
       *
       * Counted here rather than inside the loop below: a callsign can hold several schedule
       * entries — different days, different routes — and counting per entry would reach the
       * threshold on the first poll for those flights and not for others, which is a rule that
       * only looks like a rule.
       *
       * Two polls, not one. A single thin response — a partial board failure, a feed hiccup —
       * would otherwise clear every ghost at once and restore them ten seconds later, and a whole
       * map blinking is a worse fault than the twenty seconds of stale marker it saves.
       */
      for (const cs of Object.keys(flightStatusRef.current)) {
        if (vouchedCallsigns.has(cs)) delete unvouchedRef.current[cs]
        else unvouchedRef.current[cs] = (unvouchedRef.current[cs] ?? 0) + 1
      }

      const activeSchedKeys    = new Set<string>()
      const activeSchedEnRoute = new Set<string>()

      // When actual_dep_utc is known, a callsign may have multiple schedule entries
      // (different dep times for different days). Pre-compute the best-matching
      // dep_time_utc per callsign so we only render the right entry's popup/position.
      const bestSchedDepTime: Record<string, string> = {}
      for (const entry of scheduleRef.current) {
        const fss = flightStatusRef.current[entry.callsign]
        if (!fss?.actual_dep_utc) continue
        // A synthesised entry has no timetable row to match against. It previously carried
        // '00:00', which made midnight a candidate scheduled departure for any flight.
        if (!entry.dep_time_utc) continue
        // Infer scheduled departure = actual − delay so we can match to the right timetable row
        const refMs = new Date(fss.actual_dep_utc).getTime() - (fss.dep_delay_min ?? 0) * 60_000
        const refMin = new Date(refMs).getUTCHours() * 60 + new Date(refMs).getUTCMinutes()
        const [eh, em] = entry.dep_time_utc.split(':').map(Number)
        const entryMin = eh * 60 + em
        const diff = Math.min(
          Math.abs(entryMin - refMin),
          Math.abs(entryMin - refMin + 1440),
          Math.abs(entryMin - refMin - 1440),
        )
        const prior = bestSchedDepTime[entry.callsign]
        if (!prior) {
          bestSchedDepTime[entry.callsign] = entry.dep_time_utc
        } else {
          const [ph, pm] = prior.split(':').map(Number)
          const priorMin = ph * 60 + pm
          const priorDiff = Math.min(
            Math.abs(priorMin - refMin),
            Math.abs(priorMin - refMin + 1440),
            Math.abs(priorMin - refMin - 1440),
          )
          if (diff < priorDiff) bestSchedDepTime[entry.callsign] = entry.dep_time_utc
        }
      }

      for (const entry of scheduleRef.current) {
        const { callsign, dep_iata, arr_iata, dep_time_utc, arr_time_utc, duration_min, days_of_week } = entry

        // The server has stopped carrying this flight, so we stop drawing it — see the tally above.
        if ((unvouchedRef.current[callsign] ?? 0) >= 2) {
          if (schedMarkersRef.current[callsign]) {
            schedMarkersRef.current[callsign].remove(); delete schedMarkersRef.current[callsign]
            schedLinesRef.current[callsign]?.forEach((l: any) => l.remove()); delete schedLinesRef.current[callsign]  // eslint-disable-line
          }
          continue
        }

        // Real data covers this callsign — clear any ghost marker
        if (realCallsigns.has(callsign)) {
          if (schedMarkersRef.current[callsign]) {
            schedMarkersRef.current[callsign].remove(); delete schedMarkersRef.current[callsign]
            schedLinesRef.current[callsign]?.forEach((l: any) => l.remove()); delete schedLinesRef.current[callsign]  // eslint-disable-line
          }
          continue
        }

        const fs = flightStatusRef.current[callsign]
        // A callsign may have multiple schedule entries (different days / airports).
        // Once the board confirms which route is actually operating (dep_iata + arr_iata
        // are set from the boardDeparted or board-matched ADS-B injection), skip every
        // other schedule entry so they don't race to overwrite the ghost marker and
        // produce the wrong label / colour (e.g. ALP→JED on a DAM→JED Sunday flight).
        if (fs?.actual_dep_utc && fs.dep_iata && fs.arr_iata &&
            (fs.dep_iata !== dep_iata || fs.arr_iata !== arr_iata)) continue
        // When actual dep is known, skip all schedule entries except the one whose
        // dep_time_utc most closely matches the inferred scheduled departure time.
        // This prevents multiple timetable rows (same callsign, different days) from
        // overwriting each other and showing the wrong arrival time in the popup.
        if (fs?.actual_dep_utc && bestSchedDepTime[callsign] && dep_time_utc !== bestSchedDepTime[callsign]) continue
        const AIRBORNE_STATUSES  = new Set(['En Route', 'Departed', 'Approaching'])

        /*
         * The block this flight is actually flying, not the one it was filed with.
         *
         * RJ440 is filed DAM–AMM with a 50-minute block and flies it in 28. Projecting along the
         * filed figure put its marker 86 km behind the aircraft while the countdown beside it,
         * which reads the revised arrival, was correct to the minute. The live path had the same
         * fault and was fixed first; this is the other half — the ghost, and the duration handed to
         * the tracker.
         *
         * Falls back to the filed block when there is no revised arrival: before FR24 publishes
         * one, and for any flight it never resolves.
         */
        const revisedArrMs = fs?.revised_arr_utc ? Date.parse(fs.revised_arr_utc) : NaN
        const depAtMs      = fs?.actual_dep_utc  ? Date.parse(fs.actual_dep_utc)  : NaN
        const effectiveBlockMs =
          Number.isFinite(revisedArrMs) && Number.isFinite(depAtMs) && revisedArrMs > depAtMs
            ? revisedArrMs - depAtMs
            : duration_min * 60_000

        let fraction: number | null = null
        const actualArrMs  = fs?.actual_arr_utc ? new Date(fs.actual_arr_utc).getTime() : null
        const priorLegDone = actualArrMs !== null && actualArrMs < now

        if (fs?.actual_dep_utc && !priorLegDone && duration_min > 0) {
          const elapsed = now - new Date(fs.actual_dep_utc).getTime()
          if (elapsed > 0) {
            // Prefer the predictor's route fraction (hybrid DR) when available,
            // fall back to kinematic DR from kinematicStateRef, then time-based.
            const pred = predictorRef.current[callsign]
            const wpsK = routePathsRef.current[`${dep_iata}|${arr_iata}`]
            if (pred && wpsK?.length) {
              const display = pred.getDisplay(now)
              fraction = display.routeFraction > 0
                ? Math.min(display.routeFraction, 0.99)
                : climbAdjustedFraction(elapsed, effectiveBlockMs)
            } else {
              const ks = kinematicStateRef.current[callsign]
              if (ks && wpsK?.length) {
                const sinceCapMs = now - ks.captured_at_ms
                const [drLat, drLon] = projectPosition(ks.lat, ks.lon, ks.track_deg, ks.gs_kts, sinceCapMs)
                fraction = nearestPathFraction(wpsK, drLat, drLon)
              } else {
                fraction = climbAdjustedFraction(elapsed, effectiveBlockMs)
              }
            }
            // Expire dynamically: grace = max(2h, 1× flight duration) past expected arrival.
            // Short flights (EBL ~90min) expire ~3.5h after dep; long flights scale with duration.
            const graceMs = Math.max(2 * 3_600_000, duration_min * 60_000)
            if (fraction > 1.0 && elapsed - duration_min * 60_000 > graceMs) {
              fraction = null
            }
          }
        } else {
          const schedFrac = isFlightActiveNow(dep_time_utc, arr_time_utc, days_of_week, now)
          if (schedFrac !== null && duration_min > 0) {
            const impliedDepMs = fs?.revised_arr_utc
              ? new Date(fs.revised_arr_utc).getTime() - duration_min * 60_000
              : null
            if (impliedDepMs) {
              const elapsed = now - impliedDepMs
              if (elapsed > 0) {
                fraction = climbAdjustedFraction(elapsed, duration_min * 60_000)
                const graceMs = Math.max(2 * 3_600_000, duration_min * 60_000)
                if (fraction > 1.0 && elapsed - duration_min * 60_000 > graceMs) {
                  fraction = null
                }
              }
            } else if (fs && AIRBORNE_STATUSES.has(fs.status)) {
              fraction = schedFrac
            } else if (!priorLegDone) {
              // ADS-B altitude as airborne confirmation (checks trackedRef instead of lastKnownRef)
              const adsbAirborne = Object.values(trackedRef.current).some(e =>
                (e.a.flight ?? '').trim() === callsign &&
                typeof e.a.alt_baro === 'number' && e.a.alt_baro > 2_000 &&
                (now - e.lostAt) < 60 * 60_000
              )
              if (adsbAirborne) fraction = schedFrac
            }
          }
        }

        // GPS floor: prevent ESTIMATED from jumping backward.
        // Falls back to lastADSBPosRef so the floor works after stale hand-off
        // clears trackedRef (e.g. signal lost on final approach).
        if (fraction !== null && fraction < 1.0) {
          const gpsWps = routePathsRef.current[`${dep_iata}|${arr_iata}`]
          if (gpsWps?.length) {
            const lkEntry = trackedRef.current[callsign]
            const lkPos   = lkEntry
              ? { lat: lkEntry.a.lat, lon: lkEntry.a.lon, lostAt: lkEntry.lostAt }
              : lastADSBPosRef.current[callsign] ?? null
            if (lkPos && now - lkPos.lostAt < 30 * 60_000) {
              const lkFrac = nearestPathFraction(gpsWps, lkPos.lat, lkPos.lon)
              if (lkFrac > fraction) fraction = lkFrac
            }
          }
        }

        // Confirmed arrival within 4h → always show ARRIVED regardless of priorLegDone
        // priorLegDone was blocking fraction computation once actual_arr_utc was set,
        // which caused the marker to disappear exactly when it should show ARRIVED.
        if (actualArrMs !== null && now - actualArrMs < 90 * 60_000) {
          fraction = 1.1
        }

        if (fraction === null) {
          if (schedMarkersRef.current[callsign]) {
            schedMarkersRef.current[callsign].remove(); delete schedMarkersRef.current[callsign]
            schedLinesRef.current[callsign]?.forEach((l: any) => l.remove()); delete schedLinesRef.current[callsign]  // eslint-disable-line
          }
          continue
        }

        const depC = _apCoords[dep_iata]
        const arrC = _apCoords[arr_iata]
        if (!depC || !arrC) continue

        /*
         * One rule, shared with the board and the panel — see lib/flight-status.
         *
         * This was `fraction >= 1.0 && confirmedArr`, which is only right when the projection and
         * the confirmation agree, and on 14 Aug they disagreed in both directions within an hour.
         * FYC492 landed at 76% of its projected block and stayed "~ In air" with a published
         * arrival sitting unread; RJA431's projection completed nineteen minutes before it landed
         * and it stayed "~ In air" too, which on a silent Aleppo day runs to three hours.
         *
         * hasArrived answers from the flight's own facts rather than from where a projection has
         * got to: an actual arrival ends it outright, and failing that the block plus a grace
         * period does. The marker is still placed by `fraction` — that is geometry, and it is fine
         * for that — but it no longer decides whether the aircraft is down.
         */
        const confirmedArr = !!(fs?.actual_arr_utc)
        const arrived      = hasArrived({
          status:          fs?.status,
          actual_arr_utc:  fs?.actual_arr_utc,
          actual_dep_utc:  fs?.actual_dep_utc,
          revised_arr_utc: fs?.revised_arr_utc,
          duration_min,
        })
        /*
         * An arrival leaves the map the moment it lands; the panel's arrivals tab has it from
         * that same moment.
         *
         * It used to linger — half an hour of ARRIVED tags piling onto Damascus, which three
         * separate attempts tried to arrange into something readable: 8 km along the route, a
         * fixed pixel fan, then a badge standing in for the group. All of them were solving the
         * wrong problem. A map answers "where is it now", and the answer for a landed flight is
         * a line in a list, not a mark on a country.
         *
         * The last-arrival hold added on 15 Aug deliberately does not apply here, and this is the
         * one place the two paths are meant to differ. That rule keeps the newest arrival at its
         * airport, and the live loop already holds it — any flight we ever tracked has a trackedRef
         * entry that outlives the landing, and it adds itself to realCallsigns, which suppresses
         * the schedule marker for the same callsign. So a kept arrival is drawn once, from there.
         *
         * What reaches here instead is a flight we never once observed. It has no position to put
         * at the airport — only a schedule saying it should have got there — and drawing it on the
         * runway would assert an arrival nobody saw. The list can say that honestly; a marker
         * cannot.
         */
        if (arrived) {
          if (schedMarkersRef.current[callsign]) {
            schedMarkersRef.current[callsign].remove(); delete schedMarkersRef.current[callsign]
            schedLinesRef.current[callsign]?.forEach((l: any) => l.remove()); delete schedLinesRef.current[callsign]  // eslint-disable-line
          }
          continue
        }

        if (fraction >= 1.0 && !confirmedArr && !fs?.actual_dep_utc) {
          if (schedMarkersRef.current[callsign]) {
            schedMarkersRef.current[callsign].remove(); delete schedMarkersRef.current[callsign]
            schedLinesRef.current[callsign]?.forEach((l: any) => l.remove()); delete schedLinesRef.current[callsign]  // eslint-disable-line
          }
          continue
        }

        // Everything past this point is airborne — the arrival case returned above.
        const fPos = Math.min(fraction, 0.97)
        const wps  = routePathsRef.current[`${dep_iata}|${arr_iata}`]

        // On final approach with a recent ADS-B fix, pin the ghost to the last
        // known position instead of interpolating along the stored route path.
        // Route paths follow stored airways; actual flights may use different
        // airways (e.g. DAM→SHJ stored via Saudi Arabia; actual via Iraq/Kuwait),
        // causing the ghost to snap to the wrong side of the destination airport.
        const lastPos = lastADSBPosRef.current[callsign]
        const pinToLastPos = fPos >= 0.85
          && !!lastPos && now - lastPos.lostAt < 15 * 60_000

        const [lat, lon] = pinToLastPos
          ? [lastPos.lat, lastPos.lon]
          : wps?.length
            ? interpolatePath(wps, fPos)
            : slerpGreatCircle(depC[0], depC[1], arrC[0], arrC[1], fPos)
        const track = wps?.length
          ? bearingFromPath(wps, fPos)
          : bearingAlongPath(depC[0], depC[1], arrC[0], arrC[1], fPos)
        // Same two lines as the live markers, so a ghost and a tracked flight read alike.
        const schedDest = destinationLine(dep_iata, arr_iata)
        const label = schedDest ? `${callsign}\n${schedDest}` : callsign
        const hub = markerHub(dep_iata, arr_iata)
        const isSchedHighlighted = highlightedCSRef.current === callsign
        const icon  = planeIcon(L, track, true, false, label, hub, true, isSchedHighlighted ? '#ef4444' : undefined)
        const schedReg   = fs?.aircraft_reg ?? null
        const schedPhoto = (schedReg ? photoCacheRef.current[schedReg] : null) ?? photoCacheRef.current[`cs:${callsign}`] ?? null
        const popup = buildSchedulePopup(entry, false, fs, fPos, schedPhoto)

        activeSchedKeys.add(callsign)
        activeSchedEnRoute.add(callsign)

        // Schedule-overlay flights have no live fix at all — a departure time, a route and
        // an arrival estimate is everything they get, which is precisely what the rate
        // channel was built for. These are also the flights that step once per poll today,
        // since ADS-B is frequently returning nothing for the region.
        if (pinToLastPos) pinnedRef.current.add(callsign)
        if (RAF_MOTION) {
          const depAt = fs?.actual_dep_utc ? Date.parse(fs.actual_dep_utc) : null
          if (depAt && Number.isFinite(depAt)) {
            const revised = fs?.revised_arr_utc ? Date.parse(fs.revised_arr_utc) : null
            storeInputsRef.current.push({
              callsign,
              variants:       wps && wps.length >= 2 ? [wps] : [],
              dep_coords:     depC,
              arr_coords:     arrC,
              departed_at_ms: depAt,
              eta_ms:         revised && Number.isFinite(revised)
                                ? revised
                                : entry.duration_min ? depAt + entry.duration_min * 60_000 : null,
              duration_ms:    effectiveBlockMs || null,
              fix:            null,
              src:            'sched',
            })
          }
        }

        {
          if (schedMarkersRef.current[callsign]) {
            // The animation loop owns position for flights the tracker manages.
            if (!(RAF_MOTION && storeRef.current.has(callsign))) schedMarkersRef.current[callsign].setLatLng([lat, lon])
            schedMarkersRef.current[callsign].setIcon(icon)
            if (!embed) schedMarkersRef.current[callsign].setPopupContent(popup)
            if (callsign === highlightedCSRef.current || callsign === selectedCSRef.current) {
              drawTrackRoute(schedMarkersRef.current[callsign], dep_iata, arr_iata)
            }
          } else {
            const m = addToMap(L.marker([lat, lon], { icon }), map)
            /*
             * A hit is cached forever; a miss is not cached at all.
             *
             * The guard used to be `cacheKey in photoCacheRef.current`, which is true for a stored
             * `null` — so one miss meant the airline logo for the life of the page, and the retry
             * that would have fixed it never fired. That mattered because the miss was usually not
             * about the aircraft: the key was `cs:<callsign>`, a position-history lookup that fails
             * for roughly one flight in ten, chosen only because no registration had reached the
             * map. Now that the board supplies one, the same flight resolves through
             * /api/photo/{reg} — but only if it is allowed to ask again.
             *
             * Deleting the request marker rather than keeping a negative entry: the next poll
             * rebuilds the popup anyway, and by then `reg` may have arrived, which changes the key.
             */
            const fetchSchedPhoto = (cacheKey: string, apiUrl: string, onLoad: (url: string) => void) => {
              if (photoCacheRef.current[cacheKey] || photoRequestedRef.current.has(cacheKey)) return
              photoRequestedRef.current.add(cacheKey)
              const miss = () => {
                delete photoCacheRef.current[cacheKey]
                photoRequestedRef.current.delete(cacheKey)
              }
              fetch(apiUrl)
                .then(r => r.ok ? r.json() : null)
                .then(d => {
                  const url: string | null = d?.url ?? null
                  if (url) { photoCacheRef.current[cacheKey] = url; onLoad(url) } else miss()
                })
                .catch(miss)
            }
            if (embed) {
              m.on('click', () => {
                const fs  = flightStatusRef.current[callsign]
                const reg = fs?.aircraft_reg ?? null
                const ph  = reg ? photoCacheRef.current[reg] ?? null : photoCacheRef.current[`cs:${callsign}`] ?? null
                selectedCSRef.current = callsign
                rnPost({ type: 'SELECT', flight: buildEmbedFlight(callsign, entry, fs ?? null, ph) })
                const cacheKey = reg ?? `cs:${callsign}`
                const apiUrl   = reg ? `/api/photo/${encodeURIComponent(reg)}` : `/api/photo-cs/${encodeURIComponent(callsign)}`
                fetchSchedPhoto(cacheKey, apiUrl, url => {
                  if (selectedCSRef.current === callsign) {
                    const fsNow = flightStatusRef.current[callsign]
                    rnPost({ type: 'SELECT', flight: buildEmbedFlight(callsign, entry, fsNow ?? null, url) })
                  }
                })
              })
            } else {
              m.bindPopup(popup, { className: 'fp-popup', closeButton: false, maxWidth: 300 })
              m.on('click', () => {
                const fs  = flightStatusRef.current[callsign]
                const reg = fs?.aircraft_reg ?? null
                const cacheKey = reg ?? `cs:${callsign}`
                const apiUrl   = reg ? `/api/photo/${encodeURIComponent(reg)}` : `/api/photo-cs/${encodeURIComponent(callsign)}`
                fetchSchedPhoto(cacheKey, apiUrl, url => {
                  if (schedMarkersRef.current[callsign]) {
                    const fsNow = flightStatusRef.current[callsign]
                    schedMarkersRef.current[callsign].setPopupContent(
                      buildSchedulePopup(entry, arrived, fsNow, fPos, url)
                    )
                  }
                })
              })
            }
            schedMarkersRef.current[callsign] = m

            // Auto-pan + open popup for deep-linked flight (new schedule marker)
            const fNum = flightStatusRef.current[callsign]?.flight_number ?? null
            if (!embed && !autoOpenDoneRef.current && matchesTarget(fNum, callsign)) {
              autoOpenDoneRef.current = true
              highlightedCSRef.current = callsign
              setLoading(false)
              const capCs2 = callsign; const capTrack2 = track; const capLabel2 = label; const capHub2 = hub
              setTimeout(() => {
                const mk = schedMarkersRef.current[capCs2]; const mi = mapInstanceRef.current
                if (mk && mi) { mk.setIcon(planeIcon(L, capTrack2, true, false, capLabel2, capHub2, false, '#ef4444')); ((_z) => { const _w = mi.getSize().x; const _off = panelOpenRef.current && _w >= 480 ? Math.min(160, (_w - 320) / 2) : 0; const _p = mi.project(mk.getLatLng(), _z); mi.setView(mi.unproject(_p.subtract(L.point(_off, 0)), _z), _z) })(Math.max(mi.getZoom(), 8)); isAutoOpenRef.current = true; mk.openPopup(); drawTrackRoute(mk, dep_iata, arr_iata) }
              }, 300)
            }
          }

          // Auto-open for existing schedule marker
          const fNumEx = flightStatusRef.current[callsign]?.flight_number ?? null
          if (!embed && !autoOpenDoneRef.current && matchesTarget(fNumEx, callsign) && schedMarkersRef.current[callsign]) {
            autoOpenDoneRef.current = true
            highlightedCSRef.current = callsign
            setLoading(false)
            const mk = schedMarkersRef.current[callsign]; const mi = mapInstanceRef.current
            mk.setIcon(planeIcon(L, track, true, false, label, hub, false, '#ef4444'))
            if (mk && mi) { ((_z) => { const _w = mi.getSize().x; const _off = panelOpenRef.current && _w >= 480 ? Math.min(160, (_w - 320) / 2) : 0; const _p = mi.project(mk.getLatLng(), _z); mi.setView(mi.unproject(_p.subtract(L.point(_off, 0)), _z), _z) })(Math.max(mi.getZoom(), 8)); isAutoOpenRef.current = true; mk.openPopup(); drawTrackRoute(mk, dep_iata, arr_iata) }
          }
        }

        schedLinesRef.current[callsign]?.forEach((l: any) => l.remove())  // eslint-disable-line
        schedLinesRef.current[callsign] = []
      }

      // Remove schedule markers that are no longer active
      for (const cs of Object.keys(schedMarkersRef.current)) {
        if (!activeSchedKeys.has(cs)) {
          schedMarkersRef.current[cs].remove(); delete schedMarkersRef.current[cs]
          schedLinesRef.current[cs]?.forEach((l: any) => l.remove()); delete schedLinesRef.current[cs]  // eslint-disable-line
        }
      }

      // Dismiss loading spinner after first data load
      if (!firstLoadDoneRef.current) {
        firstLoadDoneRef.current = true
        if (!targetFlightRef.current) {
          setLoading(false)
        } else {
          // Flight found → auto-open already called setLoading(false); fallback if not found
          setTimeout(() => setLoading(false), 5000)
        }
      }

      // Broadcast in-air count to React Native — live ADS-B markers + schedule markers
      // that are actively en route (excludes arrived and pre-departure markers)
      if (embed) {
        const total = Object.keys(markersRef.current).length + activeSchedEnRoute.size
        rnPost({ type: 'COUNT', count: total })
      }

      // Reconcile the trackers with this poll: new flights start, landed ones are
      // dropped, fixes and revised arrivals are handed over. Nothing here moves a marker.
      if (RAF_MOTION) {
        const tNow = Date.now()
        storeRef.current.update(storeInputsRef.current, tNow)
      }
    }

    fetchUpdateRef.current = fetchAndUpdate
    fetchAndUpdate()
    const interval = setInterval(() => {
      // Skip the tick entirely while hidden: nothing is on screen to update, it spends a
      // backgrounded phone's data and battery, and it is precisely the request iOS aborts
      // when it freezes the tab — which is what put a red banner in front of a user.
      if (document.visibilityState === 'visible') fetchAndUpdate()
    }, 10_000)

    // Refresh the moment the tab comes back.
    //
    // Browsers throttle setInterval in a background tab to roughly once a minute and stop
    // requestAnimationFrame altogether, so a map left in the background falls behind: aircraft
    // sit still and a flight that has landed keeps showing en route. Without this the tab then
    // waits for the next throttled tick before catching up, which is why the same flight can
    // read as arrived in one window and still flying in another.
    const onVisible = () => { if (document.visibilityState === 'visible') fetchAndUpdate() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      fetchUpdateRef.current = null
    }
  }, [])

  // ── Animation loop ─────────────────────────────────────────────────────────
  // Ask each tracker where its flight is on every frame. Progress is a scalar advancing
  // at a known rate, so this is answerable at any instant — which is what makes the
  // 10-second poll cadence invisible instead of a visible step.
  useEffect(() => {
    if (!RAF_MOTION) return
    // Debug handle: lets the tracker state be inspected from the console.
    ;(window as unknown as Record<string, unknown>).__trackerStore = storeRef.current
    let raf = 0
    const step = () => {
      const now   = Date.now()
      const store = storeRef.current
      for (const cs of store.callsigns()) {
        const m = markersRef.current[cs] ?? schedMarkersRef.current[cs]
        if (!m) continue
        // Pinned to a real fix on final approach — the tracker still runs, but moving the
        // marker here would put it back on the stored path, which is what the pin prevents.
        if (pinnedRef.current.has(cs)) continue
        const p = store.position(cs, now)
        if (!p) continue
        m.setLatLng([p.lat, p.lon])

        // The nose has to follow the motion. Position advances every frame from the
        // tracker's own progress scalar, but the icon's rotation was only ever written at
        // poll time, from a *different* progress estimate (`fPos`, clamped to 0.97). The
        // two drift apart, so the marker slid one way while the nose pointed another —
        // measured 57 deg apart on a DAM approach, and worse where the route turns, since
        // MJI–DAM swings from 84 deg (eastbound over the Med) to 184 deg (south into DAM)
        // inside the last 15% of the path. That reads exactly as "flying sideways".
        //
        // Writing the transform on the existing <svg> rather than calling setIcon keeps it
        // cheap: no DOM rebuild per frame, and the label element is left untouched. The
        // dataset guard skips the write when the angle hasn't visibly changed, and
        // self-heals after a poll's setIcon replaces the element.
        const svg = m.getElement()?.querySelector('svg') as SVGElement | null | undefined
        if (svg && Number.isFinite(p.track_deg)) {
          const deg = Math.round(p.track_deg * 10) / 10
          if (svg.dataset.deg !== String(deg)) {
            svg.dataset.deg = String(deg)
            svg.style.transform = `rotate(${deg}deg)`
          }
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ── Load Syria GeoJSON once for geofence checks ──────────────────────────
  useEffect(() => {
    fetch('/syria_adm0.geojson').then(r => r.json()).then(geo => { syriaGeoRef.current = geo }).catch(() => {})
  }, [])

  // ── Over-Syria poll loop ─────────────────────────────────────────────────
  useEffect(() => {
    if (!overSyriaOn) {
      Object.values(overSyriaMarkersRef.current).forEach((m: any) => m.remove())  // eslint-disable-line
      overSyriaMarkersRef.current = {}
      return
    }
    const poll = async () => {
      const map = mapInstanceRef.current
      if (!map || !syriaGeoRef.current) return
      const L = (await import('leaflet')).default
      try {
        const res  = await fetch('/api/airspace')
        const data = await res.json()
        if (!data.ok) return
        const seen = new Set<string>()
        for (const a of (data.aircraft as Aircraft[])) {
          if (a.board_match) continue
          const cs = (a.flight ?? '').trim()
          if (!cs || typeof a.lat !== 'number' || typeof a.lon !== 'number') continue
          if (!isInSyria(a.lat, a.lon, syriaGeoRef.current)) continue
          seen.add(cs)
          if (overSyriaMarkersRef.current[cs]) {
            overSyriaMarkersRef.current[cs].setLatLng([a.lat, a.lon])
          } else {
            const trackDeg = a.track ?? 0
            const icon = L.divIcon({
              className: '',
              html: `<div style="width:26px;height:26px;background:#475569;border:2px solid rgba(255,255,255,.9);border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 6px rgba(0,0,0,.45)"><svg width="13" height="13" viewBox="0 0 24 24" fill="#fff" style="transform:rotate(${trackDeg}deg)"><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg></div>`,
              iconSize:   [26, 26],
              iconAnchor: [13, 13],
            })
            const altNum  = typeof a.alt_baro === 'number' ? Math.round(a.alt_baro / 100) * 100 : null
            const altDisp = altNum != null ? altNum.toLocaleString() : '—'
            const spdDisp = a.gs ? Math.round(a.gs).toString() : '—'
            const acType  = a.t ?? null
            const reg     = a.r ?? null
            const aiata   = airlineIataFor(cs)
            const alName  = airlineNameFor(aiata)
            const logoUrl = aiata ? airlineLogo(aiata) : null
            const logoWhiteBg = aiata ? LOGO_WHITE_BG.has(aiata) : false
            // Header left: airline logo when known, else a rotated plane icon
            const logoHtml = logoUrl
              ? `<img src="${logoUrl}" style="width:46px;height:46px;border-radius:10px;object-fit:contain;${logoWhiteBg ? 'background:#fff;' : 'background:#1e293b;'}padding:4px;flex-shrink:0" onerror="this.src='https://images.flightsfrom.com/airlines/100/${aiata}_100px.png';this.onerror=null">`
              : `<div style="width:46px;height:46px;border-radius:10px;background:#1e293b;flex-shrink:0;display:flex;align-items:center;justify-content:center"><svg width="22" height="22" viewBox="0 0 24 24" fill="#64748b" style="transform:rotate(${trackDeg}deg)"><path d="M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg></div>`
            // Primary line: airline name when known, else callsign
            const primaryLine = alName
              ? `<div style="font-size:14px;font-weight:700;color:#f9fafb;line-height:1.2;letter-spacing:-.01em">${alName}</div>
                 <div style="font-size:11.5px;color:#9ca3af;margin-top:3px;font-variant-numeric:tabular-nums">${cs}${acType ? ' · ' + acType : ''}</div>`
              : `<div style="font-size:15px;font-weight:700;color:#f9fafb;line-height:1.2;letter-spacing:-.01em;font-variant-numeric:tabular-nums">${cs}</div>
                 <div style="font-size:11px;color:#6b7280;margin-top:3px">${[acType, reg].filter(Boolean).join(' · ') || T('map.unknown_airline')}</div>`
            const popup = `<div dir="${RTL() ? 'rtl' : 'ltr'}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;width:260px">
              <div style="display:flex;align-items:flex-start;gap:11px;padding:14px 14px 11px">
                ${logoHtml}
                <div style="flex:1;min-width:0;text-align:start">${primaryLine}</div>
                <span style="background:#0f172a;border:1px solid #334155;color:#94a3b8;font-size:9px;font-weight:700;padding:3px 8px;border-radius:99px;flex-shrink:0;letter-spacing:${RTL() ? 'normal' : '.04em'};white-space:nowrap;margin-top:1px">${RTL() ? T('map.overflight') : T('map.overflight').toUpperCase()}</span>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1px 1fr;background:#1f2937;border-radius:0 0 14px 14px">
                <div style="text-align:center;padding:14px 8px">
                  <div style="font-size:9px;color:#4b5563;font-weight:700;text-transform:uppercase;letter-spacing:${RTL() ? 'normal' : '.7px'};margin-bottom:6px">${T('map.altitude')}</div>
                  <div style="font-size:22px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums;line-height:1">${altDisp}</div>
                  <div style="font-size:10px;color:#6b7280;margin-top:4px">${T('unit.ft')}</div>
                </div>
                <div style="background:#374151"></div>
                <div style="text-align:center;padding:14px 8px">
                  <div style="font-size:9px;color:#4b5563;font-weight:700;text-transform:uppercase;letter-spacing:${RTL() ? 'normal' : '.7px'};margin-bottom:6px">${T('map.speed')}</div>
                  <div style="font-size:22px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums;line-height:1">${spdDisp}</div>
                  <div style="font-size:10px;color:#6b7280;margin-top:4px">${T('unit.kt')}</div>
                </div>
              </div>
            </div>`
            const mk = L.marker([a.lat, a.lon], { icon, zIndexOffset: -200 })
            mk.bindPopup(popup, { className: 'fp-popup', closeButton: false, maxWidth: 280 })
            addToMap(mk, map)
            overSyriaMarkersRef.current[cs] = mk
          }
        }
        for (const cs of Object.keys(overSyriaMarkersRef.current)) {
          if (!seen.has(cs)) {
            overSyriaMarkersRef.current[cs].remove()
            delete overSyriaMarkersRef.current[cs]
          }
        }
      } catch { /* silent */ }
    }
    poll()
    const iv = setInterval(poll, 15_000)
    return () => {
      clearInterval(iv)
      Object.values(overSyriaMarkersRef.current).forEach((m: any) => m.remove())  // eslint-disable-line
      overSyriaMarkersRef.current = {}
    }
  }, [overSyriaOn])

  // The OpenSky hex-pull that used to live here ran in the browser to dodge what was
  // assumed to be a datacenter IP block. It never worked: opensky-network.org sends no
  // permissive Access-Control-Allow-Origin, so every visitor's fetch failed CORS. The
  // premise was wrong too — OpenSky does not block Vercel. It now runs server-side in
  // the harvester, and its fixes reach the map through fr24_live_position.

  return (
    <div className="relative w-full h-full">
      <style>{`
        @keyframes ft-spin{to{transform:rotate(360deg)}}
        /* Zoom sits in the bottom-right corner, lifted clear of the Over Syria toggle below
           it. Hidden on phones, where pinch-to-zoom makes it redundant.

           The selector has to outrank leaflet.css's own .leaflet-bottom .leaflet-control
           margin rule, hence the doubled-up corner classes. */
        .leaflet-bottom.leaflet-right .leaflet-control-zoom { display: none; }
        .map-oversyria { display: none; }
        @media (min-width: 768px) {
          .leaflet-bottom.leaflet-right .leaflet-control-zoom {
            display: block;
            margin-right: 12px;
            margin-bottom: 72px;
          }
          .map-oversyria { display: flex; }
        }
      `}</style>
      <div ref={mapRef} className="w-full h-full" />
      {!embed && (
        // Top-right control stack. A flex column rather than fixed `top` offsets, so the
        // Over Syria button follows the video box up and down as it collapses.
        <div style={{
          position: 'absolute', top: 10, right: 10, zIndex: 1000,
          display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
        }}>
        <VideoBox
          open={isPhone ? videoOpen : undefined}
          onToggle={setVideoOpen}
          externalTrigger={isPhone}
        />
        <PhotoBox
          open={isPhone ? photoOpen : undefined}
          onToggle={setPhotoOpen}
          externalTrigger={isPhone}
        />
        {/* Directly under the photo box, and only where there is room for it. */}
        {!isPhone && <AirportLegend />}
        {/* And the basemap choice under the key, the last thing in the stack. */}
        {!isPhone && (
          <BasemapSwitcher
            value={basemap} onChange={chooseBasemap}
            cities={cities} onCitiesChange={chooseCities}
            citiesAvailable={citiesAvailable}
          />
        )}
        </div>
      )}
      {!embed && isPhone && actionSlot && createPortal(
        <>
          <button
            onClick={() => { setVideoOpen(v => !v); setPhotoOpen(false) }}
            aria-label="Aviation Authority videos"
            aria-pressed={videoOpen}
            style={headerActionBtn(videoOpen)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <button
            onClick={() => { setPhotoOpen(v => !v); setVideoOpen(false) }}
            aria-label="Aviation Authority photos"
            aria-pressed={photoOpen}
            style={headerActionBtn(photoOpen)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m3 17 5-4.5 4 3.5 3.5-3L21 17"/>
            </svg>
          </button>
          {/* Straight to the board. The map is the entry point most people land on, and the
              full schedule was otherwise two taps away behind the menu. */}
          {/* getActiveLocale, not a bare path: this button sent an Arabic reader to the
              English board — it is the phone header's way back from the map. */}
          <a href={getActiveLocale() === 'ar' ? '/ar/board' : '/board'} aria-label={T('nav.flights')} style={{ ...headerActionBtn(false), textDecoration: 'none' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
            </svg>
          </a>
        </>,
        actionSlot,
      )}
      {/* Over Syria is a filter — it changes what the map shows — while Videos and Photos
          open content. Stacking the three together made that corner read as a wall of
          buttons, so the filter sits apart, in the slot the DAM/ALP legend used to hold.
          Zoom is already lifted 72px to clear that slot, so it still clears this.

          Desktop only: on a phone the top-right stack is most of what you can see, and this
          toggle is a power-user view of non-board traffic rather than anything a passenger
          needs. */}
      {!embed && (
        <button
          className="map-oversyria"
          onClick={() => setOverSyriaOn(v => !v)}
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
      )}
      {loading && !embed && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 2000,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(237,235,224,0.88)', backdropFilter: 'blur(6px)',
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%',
            border: '4px solid #D8D3BF', borderTopColor: '#054239',
            animation: 'ft-spin 0.85s linear infinite',
          }} />
          <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600, color: '#054239', fontFamily: "'Instrument Sans', system-ui", letterSpacing: '-.01em' }}>
            {targetFlightRef.current ? `Finding ${targetFlightRef.current}…` : 'Loading map…'}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, fontWeight: 500, color: '#556A4E', fontFamily: 'monospace', letterSpacing: '.04em' }}>
            {(loadMs / 1000).toFixed(1)}s
          </div>
        </div>
      )}
      {error && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] bg-gray-900/90 backdrop-blur px-4 py-2 rounded-full text-sm border border-gray-700">
          <span className="text-red-400">{error}</span>
        </div>
      )}
    </div>
  )
}

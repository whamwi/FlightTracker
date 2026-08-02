'use client'

import 'leaflet/dist/leaflet.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FlightPredictor } from '@/lib/flight-predictor'
import type { LivePosition as PredictorLivePos } from '@/lib/flight-predictor'
import { airlineLogo, LOGO_WHITE_BG } from '@/lib/airlines'
import { TrackerStore, type FlightInput } from '@/lib/tracker-store'
import VideoBox from './VideoBox'

// Path-anchored motion: markers are positioned by the animation loop rather than written
// once per poll. Set false to fall back to the poll writing positions directly.
const RAF_MOTION = true
import PhotoBox from './PhotoBox'
import { PANEL } from './MapBox'

interface Aircraft {
  hex: string
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
  dep_iata:       string | null
  arr_iata:       string | null
  dep_time_utc?:  string | null   // scheduled "HH:MM" UTC — popup fallback when no status
  arr_time_utc:   string | null
  duration_min:   number | null
  iata_number:    string | null
  actual_dep_utc: string | null
  actual_arr_utc: string | null
  dep_delay_min:  number | null
  airline_iata:   string | null
  seen_at?: string
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
  dep_time_utc: string   // "HH:MM"
  arr_time_utc: string   // "HH:MM"
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
  dep_delay_min:     number | null
  arr_delay_min:     number | null
  aircraft_reg:      string | null
  aircraft_type:     string | null
  flight_number:     string | null
  dep_iata:          string | null
  arr_iata:          string | null
  airline_iata:      string | null
}

import { airportCity as _apCity, airportFlag as _apFlag, airportCoords as _apCoords, airportOffset as _apOffset, airlineByIata as _alByIata, icaoToIata as _icaoToIata, loadGeoData } from '../lib/geo-data'

function iataCity(code: string | null | undefined): string {
  return (code && _apCity[code]) ? _apCity[code] : (code ?? '—')
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
  return iata ? (_alByIata[iata]?.name_en ?? null) : null
}
// Syria home airports — tiny fallback so route lines draw before geo-data loads
const AIRPORT_COORDS: Record<string, [number, number]> = {
  DAM: [33.4114, 36.5156],
  ALP: [36.1807, 37.2244],
}

const STALE_TTL_MS       = 30 * 60 * 1000
const STALE_TTL_SYRIA_MS = 6  * 60 * 60 * 1000

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
function isFlightActiveNow(depUtc: string, arrUtc: string, days: string[], nowMs: number): number | null {
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

function planeIcon(L: typeof import('leaflet'), track: number, syria: boolean, stale: boolean, label?: string, alp = false, estimated = false, colorOverride?: string) {
  const mobile  = typeof window !== 'undefined' && window.innerWidth < 768
  const size    = syria ? (mobile ? 36 : 40) : (mobile ? 26 : 30)
  const color   = colorOverride ?? (stale ? '#9ca3af' : alp ? '#f97316' : syria ? '#16a34a' : '#1d4ed8')
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
    const textColor = stale ? '#6b7280' : estimated ? '#d97706' : '#166534'
    const labelHtml = label.split('\n').map((line, i) =>
      `<div style="font-size:${mobile ? 8 : (i>0?8:9)}px;font-weight:bold;color:${i>0?'#fbbf24':textColor};letter-spacing:0.3px;line-height:1.2;white-space:nowrap">${line}</div>`
    ).join('')
    html = `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
      ${svg}<div style="text-align:center">${labelHtml}</div></div>`
  }

  return L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size/2, size/2] })
}

// Convert UTC ISO timestamp to local "HH:MM" using airport UTC offset
function popupToLocal(iso: string | null, offset: number): string {
  if (!iso) return ''
  const d = new Date(iso)
  const total = d.getUTCHours() * 60 + d.getUTCMinutes() + Math.round(offset * 60)
  const h = Math.floor(((total % 1440) + 1440) % 1440 / 60)
  const m = ((total % 1440) + 1440) % 1440 % 60
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`
}
// Convert UTC "HH:MM" schedule time to local using airport UTC offset
function schedToLocal(hhmm: string, offset: number): string {
  const [h, m] = hhmm.split(':').map(Number)
  const total = h * 60 + m + Math.round(offset * 60)
  const lh = Math.floor(((total % 1440) + 1440) % 1440 / 60)
  const lm = ((total % 1440) + 1440) % 1440 % 60
  return `${String(lh).padStart(2,'0')}:${String(lm).padStart(2,'0')}`
}

const fmtHm = (m: number) => m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`

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
function progressBarHtml(dep: string | null, arr: string | null, fraction: number | null, etaStr: string): string {
  if (!dep || !arr) return ''
  const fillPct  = fraction != null ? Math.max(1, Math.round(fraction * 100))       : 0
  const emptyPct = fraction != null ? Math.max(1, Math.round((1 - fraction) * 100)) : 100
  return `<div style="padding:4px 14px 12px">
        ${etaStr ? `<div style="text-align:center;color:#9ca3af;font-size:11px;margin-bottom:8px">${etaStr}</div>` : ''}
        <div style="display:flex;align-items:center;gap:8px">
          <div style="text-align:left">
            <div style="font-size:12px;color:#d1d5db;white-space:nowrap">${_apFlag[dep] ?? ''} ${iataCity(dep)}</div>
            <div style="font-size:10px;color:#6b7280;font-family:monospace">${dep}</div>
          </div>
          <div style="flex:1;display:flex;flex-direction:row;align-items:center;height:20px">
            <div style="flex:${fillPct};height:4px;border-radius:99px;background:${fraction!=null?'#3b82f6':'#374151'};min-width:0"></div>
            ${fraction != null ? `
              <div style="width:18px;height:18px;border-radius:9px;background:#1e293b;flex-shrink:0;border:1.5px solid #3b82f6;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 5px rgba(59,130,246,.3)">
                <svg width="9" height="9" viewBox="0 0 10 10" fill="#3b82f6"><path d="M.7 1.1 9.3 5 .7 8.9 2.5 5z"/></svg>
              </div>
              <div style="flex:${emptyPct};height:4px;border-radius:99px;background:#374151;min-width:0"></div>
            ` : ''}
          </div>
          <div style="text-align:right">
            <div style="font-size:12px;color:#d1d5db;white-space:nowrap">${iataCity(arr)} ${_apFlag[arr] ?? ''}</div>
            <div style="font-size:10px;color:#6b7280;font-family:monospace;text-align:right">${arr}</div>
          </div>
        </div>
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

  // Status badge
  const [statusLabel, statusBg, statusFg] = lostAt && !projected
    ? ['Signal Lost', '#7f1d1d', '#f87171']
    : projected
      ? ['~ En Route', '#713f12', '#fbbf24']
      : ['En Route', '#166534', '#4ade80']

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
  const arrISO = fs?.actual_arr_utc ?? fs?.revised_arr_utc ?? fs?.scheduled_arr_utc
    ?? (() => {
      const d = Date.parse(depISO ?? '')
      return Number.isFinite(d) && a.duration_min
        ? new Date(d + a.duration_min * 60_000).toISOString()
        : null
    })()

  const depMs       = Date.parse(depISO ?? '')
  const arrMs       = Date.parse(arrISO ?? '')
  const actualArrMs = Date.parse(fs?.actual_arr_utc ?? a.actual_arr_utc ?? '')
  const hasArrived  = Number.isFinite(actualArrMs) && Date.now() >= actualArrMs

  // Progress from time, not from a.lat/a.lon. Those freeze at the instant the signal drops,
  // so on a dead-reckoned flight the bar froze with them — while the schedule overlay
  // computed the same flight's progress from time. The result was a bar that jumped
  // position depending on which builder happened to render it that refresh. Geometry stays
  // only as a fallback for a live aircraft with no usable schedule.
  let fraction: number | null = null
  if (hasArrived) {
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
  if (hasArrived && Number.isFinite(depMs) && actualArrMs > depMs) {
    // Once it is down, time remaining is meaningless — how long it took is the useful number.
    etaStr = `${fmtHm(Math.round((actualArrMs - depMs) / 60_000))} flown`
  } else if (!hasArrived && Number.isFinite(arrMs)) {
    const remMin = Math.round((arrMs - Date.now()) / 60_000)
    if (remMin > 0) etaStr = `${fmtHm(remMin)} left`
  } else if (!hasArrived && arrCoord && typeof a.lat === 'number' && typeof a.lon === 'number'
             && typeof a.gs === 'number' && a.gs > 50) {
    // No arrival estimate anywhere — fall back to the geometric one. Only meaningful for a
    // genuinely live fix, which is the only case that reaches here.
    const nm = greatCircleKm(a.lat, a.lon, arrCoord[0], arrCoord[1]) / 1.852
    etaStr = `${fmtHm(Math.round(nm / a.gs * 60))} left`
  }
  // Fall back to the scheduled time carried on the aircraft when flightStatusRef has
  // nothing — the same chain buildSchedulePopup has always used. Without it the marker
  // popup rendered a bare dash while the schedule panel showed a time for the same flight
  // at the same moment: a flight surfaced as an *aircraft* is excluded from boardDeparted,
  // and boardDeparted is what populates revised_arr_utc.
  const depTimeLocal = popupToLocal(fs?.actual_dep_utc ?? fs?.revised_dep_utc ?? fs?.scheduled_dep_utc ?? null, depOffset)
                    || (a.dep_time_utc ? schedToLocal(a.dep_time_utc, depOffset) : '')
  // arrISO above, not a second chain — this is the value the countdown is measured against.
  const arrTimeLocal = popupToLocal(arrISO, arrOffset)
                    || (a.arr_time_utc ? schedToLocal(a.arr_time_utc, arrOffset) : '')

  const delayBadge = (min: number | null | undefined) => min != null && Math.abs(min) >= 2
    ? `<span style="background:#fef3c7;color:#92400e;font-size:10px;font-weight:700;padding:2px 5px;border-radius:99px;margin-left:5px;line-height:1.4">${min > 0 ? '+' : ''}${min}m</span>`
    : ''

  const progressHtml = progressBarHtml(dep, arr, fraction, etaStr)

  const timesHtml = (depTimeLocal || arrTimeLocal)
    ? `<div style="display:flex;background:#1f2937;padding:11px 14px">
        <div style="flex:1">
          <div style="font-size:9px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:3px">Departure</div>
          <div style="display:flex;align-items:baseline">
            <span style="font-size:20px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums">${depTimeLocal || '—'}</span>${delayBadge(fs?.dep_delay_min)}
          </div>
        </div>
        <div style="flex:1;text-align:right">
          <div style="font-size:9px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:3px">Arrival</div>
          <div style="display:flex;align-items:baseline;justify-content:flex-end">
            ${delayBadge(fs?.arr_delay_min)}<span style="font-size:20px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums">${arrTimeLocal || '—'}</span>
          </div>
        </div>
      </div>`
    : ''

  // Same clock as the arrival column directly above it. This was toLocaleTimeString(),
  // i.e. the *viewer's* zone, so a single card carried three unlabelled zones — departure
  // in the origin's, arrival in the destination's, this one in the reader's. On a mostly
  // diaspora audience that also made a signal-lost stamp read as later than the arrival
  // time beside it.
  const lostLocal = lostAt ? popupToLocal(new Date(lostAt).toISOString(), arrOffset) : ''
  const lostLine = lostAt && !projected
    ? `<div style="color:#ef4444;font-size:11px;padding:5px 14px">⚠ Signal lost ${lostLocal}</div>`
    : ''
  const drLine = projected && lostAt
    ? `<div style="color:#9ca3af;font-size:10px;padding:2px 14px 6px">Dead reckoning from ${lostLocal}</div>`
    : ''
  const photoHtml = photoUrl
    ? `<img src="${photoUrl}" style="width:100%;height:110px;object-fit:cover;display:block">`
    : ''

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;width:280px">
    ${photoHtml}
    <div style="display:flex;align-items:flex-start;gap:11px;padding:13px 13px 8px">
      ${logoHtml}
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:700;color:#f9fafb;line-height:1.25">${alName}</div>
        <div style="font-size:12px;color:#9ca3af;margin-top:2px">${identityLine(flightNum, callsign)}</div>
      </div>
      <span style="background:${statusBg};color:${statusFg};font-size:10px;font-weight:600;padding:3px 8px;border-radius:99px;flex-shrink:0;margin-top:1px">${statusLabel}</span>
    </div>
    ${progressHtml}${timesHtml}${lostLine}${drLine}
  </div>`
}

function buildSchedulePopup(e: ScheduleEntry, arrived = false, fs?: FlightStatus | null, fraction?: number, photoUrl?: string | null): string {
  const acType  = fs?.aircraft_type ?? null
  const aiata   = airlineIataFor(e.callsign, fs)
  const alName  = airlineNameFor(aiata) ?? (aiata ?? e.callsign)

  // Status badge
  const [statusLabel, statusBg, statusFg] = arrived
    ? ['Arrived', '#1e3a5f', '#60a5fa']
    : fraction != null && fraction > 0.02
      ? ['~ En Route', '#713f12', '#fbbf24']
      : ['Scheduled', '#1c1917', '#a8a29e']

  // Airline logo
  const logoHtml = aiata
    ? `<img src="${airlineLogo(aiata)}"
        style="width:44px;height:44px;border-radius:10px;object-fit:contain;${LOGO_WHITE_BG.has(aiata) ? 'background:#fff;' : ''}padding:4px;flex-shrink:0"
        onerror="this.src='https://images.flightsfrom.com/airlines/100/${aiata}_100px.png';this.onerror=null">`
    : `<div style="width:44px;height:44px;border-radius:10px;background:#1f2937;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:22px">${_apFlag[e.dep_iata] || '✈'}</div>`

  const depOffset = _apOffset[e.dep_iata] ?? 3
  const arrOffset = _apOffset[e.arr_iata] ?? 3

  const depTimeLocal = fs?.actual_dep_utc
    ? popupToLocal(fs.actual_dep_utc, depOffset)
    : schedToLocal(e.dep_time_utc, depOffset)
  // Same rule as buildPopup: one resolved arrival instant feeds both the ARRIVAL column and
  // the countdown below. The synthesised leg (actual departure + block time) matters for a
  // delayed flight — without it the column showed the scheduled arrival while the countdown
  // ran to the real one, so the card contradicted itself by exactly the delay.
  const bestArrISO   = fs?.actual_arr_utc ?? fs?.revised_arr_utc
    ?? (() => {
      const depMs = Date.parse(fs?.actual_dep_utc ?? '')
      return Number.isFinite(depMs) && e.duration_min > 0
        ? new Date(depMs + e.duration_min * 60_000).toISOString()
        : null
    })()
  const arrTimeLocal = bestArrISO
    ? popupToLocal(bestArrISO, arrOffset)
    : schedToLocal(e.arr_time_utc, arrOffset)

  const arrDelayMin = fs?.arr_delay_min != null ? fs.arr_delay_min
    : (fs?.revised_arr_utc && fs?.scheduled_arr_utc
        ? Math.round((new Date(fs.revised_arr_utc).getTime() - new Date(fs.scheduled_arr_utc).getTime()) / 60_000)
        : null)

  const delayBadge = (min: number | null | undefined) => min != null && Math.abs(min) >= 2
    ? `<span style="background:#fef3c7;color:#92400e;font-size:10px;font-weight:700;padding:2px 5px;border-radius:99px;margin-left:5px;line-height:1.4">${min > 0 ? '+' : ''}${min}m</span>`
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
    etaStr = `${fmtHm(Math.round((sArrMs - sDepMs) / 60_000))} flown`
  } else if (!arrived && bestArrISO) {
    const remMin = Math.round((Date.parse(bestArrISO) - Date.now()) / 60_000)
    if (remMin > 0) etaStr = `${fmtHm(remMin)} left`
  } else if (!arrived && pct != null && pct < 100 && e.duration_min > 0) {
    etaStr = `${fmtHm(Math.round(e.duration_min * (1 - (pct / 100))))} left`
  }

  const progressHtml = progressBarHtml(e.dep_iata, e.arr_iata, pct != null ? pct / 100 : null, etaStr)

  const timesHtml = `<div style="display:flex;background:#1f2937;padding:11px 14px">
    <div style="flex:1">
      <div style="font-size:9px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:3px">Departure</div>
      <div style="display:flex;align-items:baseline">
        <span style="font-size:20px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums">${depTimeLocal}</span>${delayBadge(fs?.dep_delay_min)}
      </div>
    </div>
    <div style="flex:1;text-align:right">
      <div style="font-size:9px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:3px">Arrival</div>
      <div style="display:flex;align-items:baseline;justify-content:flex-end">
        ${delayBadge(arrDelayMin)}<span style="font-size:20px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums">${arrTimeLocal}</span>
      </div>
    </div>
  </div>`

  const photoHtml = photoUrl
    ? `<img src="${photoUrl}" style="width:100%;height:110px;object-fit:cover;display:block">`
    : ''

  const noteHtml = !arrived
    ? `<div style="color:#6b7280;font-size:10px;padding:4px 14px 5px">Schedule projection · no live signal</div>`
    : ''

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;width:280px">
    ${photoHtml}
    <div style="display:flex;align-items:flex-start;gap:11px;padding:13px 13px 8px">
      ${logoHtml}
      <div style="flex:1;min-width:0">
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
  // Markers keyed by CALLSIGN (not hex) — one entry per flight
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef      = useRef<Record<string, any>>({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const linesRef        = useRef<Record<string, any[]>>({})
  // Schedule-based projected markers (key = callsign)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schedMarkersRef = useRef<Record<string, any>>({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schedLinesRef   = useRef<Record<string, any[]>>({})
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

  useEffect(() => {
    if (!targetFlight) return
    autoOpenDoneRef.current = false
    highlightedCSRef.current = null
    setLoading(true)
    fetchUpdateRef.current?.()
    // Fallback: clear spinner after 3s if flight isn't found in the feed
    const t = setTimeout(() => setLoading(false), 3000)
    return () => clearTimeout(t)
  }, [targetFlight])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trackLinesRef     = useRef<any[]>([])
  // Last confirmed ADS-B lat/lon per callsign — kept alive through stale hand-off
  // so the schedule overlay GPS floor still works after trackedRef is cleared.
  const lastADSBPosRef    = useRef<Record<string, { lat: number; lon: number; lostAt: number }>>({})
  // Last kinematic state per callsign — kept for schedule-overlay DR fallback.
  const kinematicStateRef = useRef<Record<string, KinematicState>>({})
  // One FlightPredictor per callsign — handles hybrid DR + smooth recovery for ADS-B entries.
  const predictorRef      = useRef<Record<string, FlightPredictor>>({})
  // Path-anchored trackers, one per airborne flight, driving the animation loop.
  const storeRef          = useRef<TrackerStore>(new TrackerStore())
  const storeInputsRef    = useRef<FlightInput[]>([])
  const lastFedPosRef     = useRef<Record<string, string>>({})

  const [error, setError]     = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadMs, setLoadMs]   = useState(0)
  const firstLoadDoneRef      = useRef(false)

  // ── Over-Syria feature state ─────────────────────────────────────────────
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
    const mq = window.matchMedia('(max-width: 767px)')
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
  const lastLoggedPosRef = useRef<Record<string, { lat: number; lon: number; alt: number | null }>>({})

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
      })
      if (embed) {
        map.fitBounds([[22, 26], [43, 62]])
      }

      // Leaflet prepends its own "Leaflet |" credit. It is MIT-licensed and asks for no
      // attribution, so that part is courtesy rather than obligation — dropping it takes
      // roughly a quarter off the strip's width. What remains is the wording OSM and CARTO
      // actually require, which is the floor short of hiding it behind a tap-to-expand
      // control.
      map.attributionControl.setPrefix(false)
      // Added before the tile layer so it lands above the attribution in the bottom-right
      // corner. Desktop-only, but gated in CSS rather than on innerWidth — a one-shot
      // width read here can fire before the viewport settles and silently drop the control.
      if (!embed) {
        L.control.zoom({ position: 'bottomright' }).addTo(map)
      }
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19,
      }).addTo(map)
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
      const SERVICED: [number, number][] = [
        // Syrian airports
        [33.4114, 36.5156], // DAM
        [36.1807, 37.2244], // ALP
        [35.4011, 35.9488], // LTK
        [35.2854, 40.1760], // DEZ
        // Active destinations (last 7 days)
        [31.7226, 35.9930], // AMM
        [52.3086,  4.7639], // AMS
        [24.4330, 54.6511], // AUH
        [33.2626, 44.2346], // BGW
        [26.4712, 49.7979], // DMM
        [25.2731, 51.6081], // DOH
        [25.2528, 55.3644], // DXB
        [36.2376, 43.9631], // EBL
        [40.1281, 32.9951], // ESB
        [41.2608, 28.7418], // IST
        [21.6796, 39.1565], // JED
        [15.5895, 32.5532], // KRT
        [29.2267, 47.9689], // KWI
        [23.5933, 58.2844], // MCT
        [32.8942, 13.2759], // MJI
        [44.5711, 26.0850], // OTP
        [24.9578, 46.6989], // RUH
        [40.8986, 29.3092], // SAW
        [25.3285, 55.5172], // SHJ
        [51.2895,  6.7668], // DUS
        [52.3667, 13.5033], // BER
        [36.8987, 30.7999], // AYT
      ]
      for (const coords of SERVICED) {
        L.circle(coords, {
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
    return () => { mapInstanceRef.current?.remove(); mapInstanceRef.current = null }
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
      const L   = (await import('leaflet')).default
      const map = mapInstanceRef.current
      if (!map) return

      const now = Date.now()

      // Draw completed + remaining route lines for the tracked flight
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const drawTrackRoute = (marker: any, depIata: string | null, arrIata: string | null) => {
        trackLinesRef.current.forEach(l => l.remove())
        trackLinesRef.current = []
        const pos      = marker.getLatLng()
        const depCoord = depIata ? _apCoords[depIata] : null
        const arrCoord = arrIata ? _apCoords[arrIata] : null
        if (arrCoord) {
          trackLinesRef.current.push(
            L.polyline([[pos.lat, pos.lng], [arrCoord[0], arrCoord[1]]], {
              color: '#054239', weight: 1.5, opacity: 0.55, dashArray: '6 9',
            }).addTo(map)
          )
        }
      }

      // ── 1. Fetch feed + update trackedRef (keyed by callsign) ─────────────
      const freshCallsigns = new Set<string>()  // callsigns in THIS cycle's live feed
      try {
        const res  = await fetch('/api/airspace')
        const data = await res.json()
        if (!data.ok) { setError(data.warn ?? 'feed error'); return }

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
              const fixAt      = Date.parse((a as any).fix_at ?? '') || 0
              const fr24LostAt = fixAt || fr24Ts || now - 30_000
              const prevFr24   = trackedRef.current[cs]
              if (!prevFr24 || prevFr24.lostAt <= fr24LostAt) {
                trackedRef.current[cs] = { a, lostAt: fr24LostAt, isFr24: true }
              }
            } else {
              // Live ADS-B: prefer non-stale, then highest gs (freshest fix)
              const prev = trackedRef.current[cs]
              if (!prev || prev.lostAt > 0 || (a.gs ?? 0) >= (prev.a.gs ?? 0)) {
                trackedRef.current[cs] = { a, lostAt: 0, isFr24: false }
              }
              freshCallsigns.add(cs)  // record as seen in this live cycle
            }
          }

          // Seed flightStatusRef from board_match aircraft with lifecycle timestamps
          for (const a of data.aircraft as Aircraft[]) {
            if (!a.board_match || (!a.actual_dep_utc && !a.actual_arr_utc)) continue
            const cs = (a.flight ?? '').trim()
            if (!cs) continue
            const existing = flightStatusRef.current[cs]
            flightStatusRef.current[cs] = {
              callsign:          cs,
              status:            a.actual_arr_utc ? 'Arrived' : 'Departed',
              actual_dep_utc:    a.actual_dep_utc    ?? existing?.actual_dep_utc    ?? null,
              actual_arr_utc:    a.actual_arr_utc    ?? existing?.actual_arr_utc    ?? null,
              scheduled_dep_utc: existing?.scheduled_dep_utc ?? null,
              scheduled_arr_utc: existing?.scheduled_arr_utc ?? null,
              revised_dep_utc:   existing?.revised_dep_utc   ?? null,
              revised_arr_utc:   existing?.revised_arr_utc   ?? null,
              dep_delay_min:     a.dep_delay_min ?? existing?.dep_delay_min ?? null,
              arr_delay_min:     existing?.arr_delay_min      ?? null,
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
            actual_dep_utc: string | null; actual_arr_utc: string | null
            revised_arr_utc: string | null
            iata_number: string; dep_delay_min: number | null; airline_iata: string | null
          }[]) {
            const { callsign: cs, dep_iata, arr_iata, duration_min,
                    actual_dep_utc, actual_arr_utc, revised_arr_utc, iata_number, dep_delay_min, airline_iata } = bd
            if (!cs || !dep_iata || !arr_iata) continue
            const existing = flightStatusRef.current[cs]
            // Synthesize estimated arrival from actual_dep + duration when no explicit revised/actual arr
            const effectiveDep = actual_dep_utc ?? existing?.actual_dep_utc ?? null
            const estimatedArr = !actual_arr_utc && !revised_arr_utc && effectiveDep && duration_min > 0
              ? new Date(new Date(effectiveDep).getTime() + duration_min * 60_000).toISOString()
              : null
            flightStatusRef.current[cs] = {
              callsign:          cs,
              status:            actual_arr_utc ? 'Arrived' : 'Departed',
              actual_dep_utc:    actual_dep_utc ?? existing?.actual_dep_utc ?? null,
              actual_arr_utc:    actual_arr_utc ?? existing?.actual_arr_utc ?? null,
              scheduled_dep_utc: existing?.scheduled_dep_utc ?? null,
              scheduled_arr_utc: existing?.scheduled_arr_utc ?? null,
              revised_dep_utc:   existing?.revised_dep_utc   ?? null,
              revised_arr_utc:   revised_arr_utc ?? estimatedArr ?? existing?.revised_arr_utc ?? null,
              dep_delay_min:     dep_delay_min ?? existing?.dep_delay_min ?? null,
              arr_delay_min:     existing?.arr_delay_min ?? null,
              aircraft_reg:      existing?.aircraft_reg  ?? null,
              aircraft_type:     existing?.aircraft_type ?? null,
              flight_number:     iata_number,
              dep_iata, arr_iata, airline_iata,
            }
            // Cache the effective duration so schedule reloads can re-apply it
            durationOverridesRef.current[cs] = duration_min
            const existingSchedIdx = scheduleRef.current.findIndex(e => e.callsign === cs)
            if (existingSchedIdx === -1) {
              scheduleRef.current.push({
                callsign: cs, dep_iata, arr_iata,
                dep_time_utc: '00:00', arr_time_utc: '00:00',
                duration_min, days_of_week: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
              })
            } else {
              // boardDeparted carries effectiveDurationMin (actual dep → revised arr when known),
              // which is more accurate than the stored schedule block time — update it.
              scheduleRef.current[existingSchedIdx] = {
                ...scheduleRef.current[existingSchedIdx],
                duration_min,
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
        setError(String(e))
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

      // ── 2b. Log live ADS-B positions for board-matched flights ───────────────
      // Fire-and-forget — never block the render loop
      if (freshCallsigns.size > 0) {
        const syriaDt = new Date(now + 3 * 3_600_000).toISOString().slice(0, 10)
        const batch = [...freshCallsigns].flatMap(cs => {
          const entry = trackedRef.current[cs]
          if (!entry || entry.lostAt > 0) return []
          const a = entry.a
          const alt = typeof a.alt_baro === 'number' ? a.alt_baro
                    : a.alt_baro === 'ground'        ? 0
                    : null
          // Skip if position unchanged since last log (stale ADS-B tick)
          const prev = lastLoggedPosRef.current[cs]
          if (prev && prev.lat === a.lat && prev.lon === a.lon && prev.alt === alt) return []
          lastLoggedPosRef.current[cs] = { lat: a.lat, lon: a.lon, alt }
          return [{
            callsign:    cs,
            flight_date: syriaDt,
            lat:         a.lat,
            lon:         a.lon,
            alt_baro:    alt,
            gs:          a.gs,
            track:       a.track,
            hex:         a.hex,
            dep_iata:    a.dep_iata,
            arr_iata:    a.arr_iata,
            iata_number: a.iata_number,
          }]
        })
        if (batch.length > 0) {
          fetch('/api/signal-log', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(batch),
          }).catch(() => {})
        }

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

      for (const [cs, entry] of Object.entries(trackedRef.current)) {
        const { a, lostAt, isFr24 } = entry

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
          const sched = scheduleRef.current.find(e => e.callsign === cs)
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
        const isAlp      = a.arr_iata === 'ALP' || a.dep_iata === 'ALP'
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
          if (fsArrUtc && now - new Date(fsArrUtc).getTime() > 90 * 60_000) {
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
              const se_ = scheduleRef.current.find(e => e.callsign === cs)
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
          const schedEntry = scheduleRef.current.find(e => e.callsign === cs)
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
          const se_ = scheduleRef.current.find(e => e.callsign === cs)
          const arrIata_ = se_?.arr_iata ?? a.arr_iata ?? null
          const arrC_ = arrIata_ ? _apCoords[arrIata_] : null
          if (arrC_) { dispLat = arrC_[0]; dispLon = arrC_[1]; arrSnapped = true; projected = true }
        }

        // Confirmed arrival snap
        if (!arrSnapped) {
          const fsFix = flightStatusRef.current[cs]
          if (fsFix?.actual_arr_utc && now - new Date(fsFix.actual_arr_utc).getTime() < 4 * 3_600_000) {
            const seFix = scheduleRef.current.find(e => e.callsign === cs)
            const arrFix = (seFix ? _apCoords[seFix.arr_iata] : null)
                        ?? (fsFix.arr_iata ? _apCoords[fsFix.arr_iata] : null)
                        ?? (a.arr_iata    ? _apCoords[a.arr_iata]    : null)
            if (arrFix) { dispLat = arrFix[0]; dispLon = arrFix[1]; arrSnapped = true }
          }
        }

        // Stale un-projected: park pre-departure or post-arrival
        if (a.stale && !projected) {
          const se = scheduleRef.current.find(e => e.callsign === cs)
          if (se && isFlightActiveNow(se.dep_time_utc, se.arr_time_utc, se.days_of_week, now) === null) {
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

        const staleLabel    = arrSnapped ? `${cs}\nARRIVED` : cs
        const isEstimated   = projected && !arrSnapped
        const isHighlighted = highlightedCSRef.current === cs
        const icon    = planeIcon(L, dispTrack, true, arrSnapped, staleLabel, isAlp, isEstimated, isHighlighted ? '#ef4444' : undefined)
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
              eta_ms:         a.duration_min ? depAt + a.duration_min * 60_000 : null,
              duration_ms:    a.duration_min ? a.duration_min * 60_000 : null,
              fix: (moved && isLive) ? {
                lat: a.lat, lon: a.lon, at_ms: now,
                gs_kts: a.gs ?? null, track_deg: a.track ?? null,
                altitude_ft: typeof a.alt_baro === 'number' ? a.alt_baro : null,
              } : null,
            })
          }
        }

        if (markersRef.current[cs]) {
          // The animation loop owns position for flights the tracker manages.
          if (!(RAF_MOTION && storeRef.current.has(cs))) markersRef.current[cs].setLatLng([dispLat, dispLon])
          markersRef.current[cs].setIcon(icon)
          if (!embed) markersRef.current[cs].setPopupContent(popup)
          if (cs === highlightedCSRef.current || cs === selectedCSRef.current) {
            const se_ = scheduleRef.current.find(e => e.callsign === cs)
            drawTrackRoute(markersRef.current[cs], se_?.dep_iata ?? a.dep_iata ?? null, se_?.arr_iata ?? a.arr_iata ?? null)
          }
        } else {
          const m = L.marker([dispLat, dispLon], { icon }).addTo(map)
          if (embed) {
            m.on('click', () => {
              const fs  = flightStatusRef.current[cs]
              const se  = scheduleRef.current.find(e => e.callsign === cs)
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
            const capTrack = dispTrack; const capLabel = staleLabel; const capAlp = isAlp; const capEst = isEstimated
            setTimeout(() => {
              const mk = markersRef.current[capCs]; const mi = mapInstanceRef.current
              if (mk && mi) { mk.setIcon(planeIcon(L, capTrack, true, false, capLabel, capAlp, capEst, '#ef4444')); ((_z) => { const _w = mi.getSize().x; const _off = panelOpenRef.current && _w >= 480 ? Math.min(160, (_w - 320) / 2) : 0; const _p = mi.project(mk.getLatLng(), _z); mi.setView(mi.unproject(_p.subtract(L.point(_off, 0)), _z), _z) })(Math.max(mi.getZoom(), 8)); isAutoOpenRef.current = true; mk.openPopup(); drawTrackRoute(mk, capDep, capArr) }
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
          mk.setIcon(planeIcon(L, dispTrack, true, false, staleLabel, isAlp, isEstimated, '#ef4444'))
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
                const seNow = scheduleRef.current.find(e => e.callsign === capturedCS) ?? null
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
      const activeSchedKeys    = new Set<string>()
      const activeSchedEnRoute = new Set<string>()

      // When actual_dep_utc is known, a callsign may have multiple schedule entries
      // (different dep times for different days). Pre-compute the best-matching
      // dep_time_utc per callsign so we only render the right entry's popup/position.
      const bestSchedDepTime: Record<string, string> = {}
      for (const entry of scheduleRef.current) {
        const fss = flightStatusRef.current[entry.callsign]
        if (!fss?.actual_dep_utc) continue
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
                : elapsed / (duration_min * 60_000)
            } else {
              const ks = kinematicStateRef.current[callsign]
              if (ks && wpsK?.length) {
                const sinceCapMs = now - ks.captured_at_ms
                const [drLat, drLon] = projectPosition(ks.lat, ks.lon, ks.track_deg, ks.gs_kts, sinceCapMs)
                fraction = nearestPathFraction(wpsK, drLat, drLon)
              } else {
                fraction = elapsed / (duration_min * 60_000)
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
                fraction = elapsed / (duration_min * 60_000)
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

        const confirmedArr = !!(fs?.actual_arr_utc)
        const arrived      = fraction >= 1.0 && confirmedArr
        if (fraction >= 1.0 && !confirmedArr && !fs?.actual_dep_utc) {
          if (schedMarkersRef.current[callsign]) {
            schedMarkersRef.current[callsign].remove(); delete schedMarkersRef.current[callsign]
            schedLinesRef.current[callsign]?.forEach((l: any) => l.remove()); delete schedLinesRef.current[callsign]  // eslint-disable-line
          }
          continue
        }

        const fPos = arrived ? 1.0 : Math.min(fraction, 0.97)
        const wps  = routePathsRef.current[`${dep_iata}|${arr_iata}`]

        // On final approach with a recent ADS-B fix, pin the ghost to the last
        // known position instead of interpolating along the stored route path.
        // Route paths follow stored airways; actual flights may use different
        // airways (e.g. DAM→SHJ stored via Saudi Arabia; actual via Iraq/Kuwait),
        // causing the ghost to snap to the wrong side of the destination airport.
        const lastPos = lastADSBPosRef.current[callsign]
        const pinToLastPos = !arrived && fPos >= 0.85
          && !!lastPos && now - lastPos.lostAt < 15 * 60_000

        const [lat, lon] = pinToLastPos
          ? [lastPos.lat, lastPos.lon]
          : wps?.length
            ? interpolatePath(wps, fPos)
            : slerpGreatCircle(depC[0], depC[1], arrC[0], arrC[1], fPos)
        const track = wps?.length
          ? bearingFromPath(wps, fPos)
          : bearingAlongPath(depC[0], depC[1], arrC[0], arrC[1], fPos)
        const label = arrived ? `${callsign}\nARRIVED` : callsign
        const isAlp = dep_iata === 'ALP' || arr_iata === 'ALP'
        const isSchedHighlighted = highlightedCSRef.current === callsign
        const icon  = planeIcon(L, track, true, arrived, label, isAlp, !arrived, isSchedHighlighted ? '#ef4444' : undefined)
        const schedReg   = fs?.aircraft_reg ?? null
        const schedPhoto = (schedReg ? photoCacheRef.current[schedReg] : null) ?? photoCacheRef.current[`cs:${callsign}`] ?? null
        const popup = buildSchedulePopup(entry, arrived, fs, fPos, schedPhoto)

        activeSchedKeys.add(callsign)
        if (!arrived) activeSchedEnRoute.add(callsign)

        // Schedule-overlay flights have no live fix at all — a departure time, a route and
        // an arrival estimate is everything they get, which is precisely what the rate
        // channel was built for. These are also the flights that step once per poll today,
        // since ADS-B is frequently returning nothing for the region.
        if (RAF_MOTION && !arrived && !pinToLastPos) {
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
              duration_ms:    entry.duration_min ? entry.duration_min * 60_000 : null,
              fix:            null,
            })
          }
        }

        if (schedMarkersRef.current[callsign]) {
          // The animation loop owns position for flights the tracker manages.
          if (!(RAF_MOTION && storeRef.current.has(callsign))) schedMarkersRef.current[callsign].setLatLng([lat, lon])
          schedMarkersRef.current[callsign].setIcon(icon)
          if (!embed) schedMarkersRef.current[callsign].setPopupContent(popup)
          if (callsign === highlightedCSRef.current || callsign === selectedCSRef.current) {
            drawTrackRoute(schedMarkersRef.current[callsign], dep_iata, arr_iata)
          }
        } else {
          const m = L.marker([lat, lon], { icon }).addTo(map)
          const fetchSchedPhoto = (cacheKey: string, apiUrl: string, onLoad: (url: string) => void) => {
            if (cacheKey in photoCacheRef.current || photoRequestedRef.current.has(cacheKey)) return
            photoRequestedRef.current.add(cacheKey)
            fetch(apiUrl)
              .then(r => r.ok ? r.json() : null)
              .then(d => {
                const url: string | null = d?.url ?? null
                photoCacheRef.current[cacheKey] = url
                if (url) onLoad(url)
              })
              .catch(() => { photoCacheRef.current[cacheKey] = null })
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
            const capCs2 = callsign; const capTrack2 = track; const capLabel2 = label; const capAlp2 = isAlp
            setTimeout(() => {
              const mk = schedMarkersRef.current[capCs2]; const mi = mapInstanceRef.current
              if (mk && mi) { mk.setIcon(planeIcon(L, capTrack2, true, false, capLabel2, capAlp2, false, '#ef4444')); ((_z) => { const _w = mi.getSize().x; const _off = panelOpenRef.current && _w >= 480 ? Math.min(160, (_w - 320) / 2) : 0; const _p = mi.project(mk.getLatLng(), _z); mi.setView(mi.unproject(_p.subtract(L.point(_off, 0)), _z), _z) })(Math.max(mi.getZoom(), 8)); isAutoOpenRef.current = true; mk.openPopup(); drawTrackRoute(mk, dep_iata, arr_iata) }
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
          mk.setIcon(planeIcon(L, track, true, false, label, isAlp, false, '#ef4444'))
          if (mk && mi) { ((_z) => { const _w = mi.getSize().x; const _off = panelOpenRef.current && _w >= 480 ? Math.min(160, (_w - 320) / 2) : 0; const _p = mi.project(mk.getLatLng(), _z); mi.setView(mi.unproject(_p.subtract(L.point(_off, 0)), _z), _z) })(Math.max(mi.getZoom(), 8)); isAutoOpenRef.current = true; mk.openPopup(); drawTrackRoute(mk, dep_iata, arr_iata) }
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
      if (RAF_MOTION) storeRef.current.update(storeInputsRef.current, Date.now())
    }

    fetchUpdateRef.current = fetchAndUpdate
    fetchAndUpdate()
    const interval = setInterval(fetchAndUpdate, 10_000)
    return () => { clearInterval(interval); fetchUpdateRef.current = null }
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
                 <div style="font-size:11px;color:#6b7280;margin-top:3px">${[acType, reg].filter(Boolean).join(' · ') || 'Unknown airline'}</div>`
            const popup = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;width:260px">
              <div style="display:flex;align-items:flex-start;gap:11px;padding:14px 14px 11px">
                ${logoHtml}
                <div style="flex:1;min-width:0">${primaryLine}</div>
                <span style="background:#0f172a;border:1px solid #334155;color:#94a3b8;font-size:9px;font-weight:700;padding:3px 8px;border-radius:99px;flex-shrink:0;letter-spacing:.04em;white-space:nowrap;margin-top:1px">OVERFLIGHT</span>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1px 1fr;background:#1f2937;border-radius:0 0 14px 14px">
                <div style="text-align:center;padding:14px 8px">
                  <div style="font-size:9px;color:#4b5563;font-weight:700;text-transform:uppercase;letter-spacing:.7px;margin-bottom:6px">Altitude</div>
                  <div style="font-size:22px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums;line-height:1">${altDisp}</div>
                  <div style="font-size:10px;color:#6b7280;margin-top:4px">ft</div>
                </div>
                <div style="background:#374151"></div>
                <div style="text-align:center;padding:14px 8px">
                  <div style="font-size:9px;color:#4b5563;font-weight:700;text-transform:uppercase;letter-spacing:.7px;margin-bottom:6px">Speed</div>
                  <div style="font-size:22px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums;line-height:1">${spdDisp}</div>
                  <div style="font-size:10px;color:#6b7280;margin-top:4px">kt</div>
                </div>
              </div>
            </div>`
            const mk = L.marker([a.lat, a.lon], { icon, zIndexOffset: -200 })
            mk.bindPopup(popup, { className: 'fp-popup', closeButton: false, maxWidth: 280 })
            mk.addTo(map)
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
  // /api/cron/opensky-poll, and its fixes reach the map through /api/airspace.

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
          Over Syria
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

'use client'

import 'leaflet/dist/leaflet.css'
import { useEffect, useRef, useState } from 'react'
import { FlightPredictor } from '@/lib/flight-predictor'
import type { LivePosition as PredictorLivePos } from '@/lib/flight-predictor'

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

// ICAO airline prefix → IATA code (for airline logo)
const ICAO_TO_IATA: Record<string, string> = {
  FDB: 'FZ', ABY: 'G9', THY: 'TK', RJA: 'RJ',
  QTR: 'QR', ETD: 'EY', PGT: 'PC', SYR: 'RB',
  JZR: 'J9', ADY: 'TK', FYC: 'XH',
}

// Airport IATA → city name for popup route line
const IATA_CITY: Record<string, string> = {
  DAM: 'Damascus',  ALP: 'Aleppo',    DXB: 'Dubai',
  SHJ: 'Sharjah',  AUH: 'Abu Dhabi', BEY: 'Beirut',
  AMM: 'Amman',    CAI: 'Cairo',      IST: 'Istanbul',
  SAW: 'Istanbul', AYT: 'Antalya',    ADB: 'Izmir',
  ESB: 'Ankara',   BAH: 'Bahrain',    DOH: 'Doha',
  KWI: 'Kuwait',   MCT: 'Muscat',     BGW: 'Baghdad',
  BSR: 'Basra',    NJF: 'Najaf',      THR: 'Tehran',
  MHD: 'Mashhad',  JED: 'Jeddah',     RUH: 'Riyadh',
  SVO: 'Moscow',   HRG: 'Hurghada',   TBS: 'Tbilisi',
  GYD: 'Baku',     KBP: 'Kyiv',       VIE: 'Vienna',
}
function iataCity(code: string | null | undefined): string {
  return (code && IATA_CITY[code]) ? IATA_CITY[code] : (code ?? '—')
}
function airlineIataFor(callsign: string, fs?: FlightStatus | null): string | null {
  if (fs?.airline_iata) return fs.airline_iata
  // flight_number is IATA format like "FZ1847" — first 2 alpha chars = IATA
  const fn = fs?.flight_number ?? ''
  const fnLetters = fn.replace(/[^A-Za-z]/g, '')
  if (fnLetters.length === 2) return fnLetters.toUpperCase()
  // Fall back: first 3 alpha chars of callsign = ICAO prefix
  const icao = callsign.replace(/\d/g, '').toUpperCase()
  return ICAO_TO_IATA[icao] ?? null
}

// Syria destination airports — used for route lines
const AIRPORT_COORDS: Record<string, [number, number]> = {
  DAM: [33.4114, 36.5156],
  ALP: [36.1807, 37.2244],
}

// All airports in our schedule — used for great-circle projection origin
const ALL_AIRPORT_COORDS: Record<string, [number, number]> = {
  DAM: [33.4114, 36.5156],
  ALP: [36.1807, 37.2244],
  SAW: [40.8986, 29.3092],
  IST: [41.2608, 28.7418],
  AYT: [36.8987, 30.7995],
  AMM: [31.7226, 35.9930],
  BEY: [33.8208, 35.4883],
  CAI: [30.1219, 31.4056],
  HRG: [27.1783, 33.7993],
  DXB: [25.2528, 55.3644],
  SHJ: [25.3285, 55.5172],
  AUH: [24.4330, 54.6511],
  KWI: [29.2267, 47.9689],
  MCT: [23.5933, 58.2844],
  RUH: [24.9578, 46.6989],
  DMM: [26.4712, 49.7979],
  JED: [21.6796, 39.1565],
  MED: [24.5534, 39.7051],
  BGW: [33.2626, 44.2346],
  BSR: [30.5491, 47.6622],
  TBS: [41.6692, 44.9547],
  SKD: [39.7005, 66.9838],
  TAS: [41.2579, 69.2812],
  VKO: [55.5965, 37.2615],
  SVO: [55.9736, 37.4125],
  EVN: [40.1473, 44.3959],
  KHI: [24.9065, 67.1608],
  LCA: [34.8751, 33.6249],
  // Added from schedule validation
  AMS: [52.3086,  4.7639],  // Amsterdam Schiphol
  DOH: [25.2731, 51.6081],  // Doha Hamad International
  EBL: [36.2376, 43.9631],  // Erbil International
  MJI: [32.8942, 13.2759],  // Mitiga (Tripoli)
  TIP: [32.6635, 13.1515],  // Tripoli International
  BAH: [26.2708, 50.6336],  // Bahrain
  NJF: [31.9890, 44.4042],  // Najaf
  ADB: [38.2924, 27.1570],  // Izmir
  ESB: [40.1281, 32.9951],  // Ankara Esenboga
  THR: [35.6892, 51.3130],  // Tehran Mehrabad
  MHD: [36.2352, 59.6400],  // Mashhad
  GYD: [40.4675, 50.0467],  // Baku
  ATH: [37.9364, 23.9445],  // Athens
  FCO: [41.8003, 12.2389],  // Rome
  CDG: [49.0097,  2.5479],  // Paris CDG
  LHR: [51.4700, -0.4543],  // London Heathrow
  FRA: [50.0379,  8.5622],  // Frankfurt
  VIE: [48.1103, 16.5697],  // Vienna
  ADD: [ 8.9779, 38.7993],  // Addis Ababa
  NBO: [-1.3192, 36.9275],  // Nairobi
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

function planeIcon(L: typeof import('leaflet'), track: number, syria: boolean, stale: boolean, label?: string, alp = false, estimated = false) {
  const size    = syria ? 40 : 30
  const color   = stale ? '#9ca3af' : alp ? '#f97316' : syria ? '#16a34a' : '#1d4ed8'
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
    const textColor = stale ? '#9ca3af' : estimated ? '#fbbf24' : '#4ade80'
    const labelHtml = label.split('\n').map((line, i) =>
      `<div style="font-size:${i>0?8:9}px;font-weight:bold;color:${i>0?'#fbbf24':textColor};
        text-shadow:0 1px 3px rgba(0,0,0,1),0 0 6px rgba(0,0,0,0.9);letter-spacing:0.3px;
        line-height:1.2;white-space:nowrap">${line}</div>`
    ).join('')
    html = `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
      ${svg}<div style="text-align:center">${labelHtml}</div></div>`
  }

  return L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size/2, size/2] })
}

function buildPopup(
  a: Aircraft,
  lostAt?: number,
  projected?: boolean,
  fs?: FlightStatus | null,
  photoUrl?: string | null,
): string {
  const callsign  = (a.flight ?? '').trim() || a.hex
  const alt       = typeof a.alt_baro === 'number' ? `${Math.round(a.alt_baro).toLocaleString()} ft` : '—'
  const spd       = a.gs ? `${Math.round(a.gs)} kts` : '—'
  const arrSyria  = a.board_match && !!a.arr_iata && !!AIRPORT_COORDS[a.arr_iata]

  const acType    = fs?.aircraft_type ?? a.t ?? null
  const dep       = fs?.dep_iata ?? a.dep_iata ?? null
  const arr       = fs?.arr_iata ?? a.arr_iata ?? null
  const aiata     = airlineIataFor(callsign, fs)

  // Distance + ETA to destination
  const destCode  = fs?.arr_iata ?? a.arr_iata ?? null
  const destCoord = destCode ? ALL_AIRPORT_COORDS[destCode] : null
  let distLine = ''
  if (destCoord && typeof a.lat === 'number' && typeof a.lon === 'number') {
    const nm  = greatCircleKm(a.lat, a.lon, destCoord[0], destCoord[1]) / 1.852
    const gs  = typeof a.gs === 'number' && a.gs > 50 ? a.gs : null
    const eta = gs ? Math.round(nm / gs * 60) : null
    const etaStr = eta != null
      ? eta >= 60 ? `${Math.floor(eta / 60)}h ${eta % 60}m` : `${eta}m`
      : null
    distLine = `<div style="color:#3b82f6;font-size:11px;margin-top:4px">` +
      `${Math.round(nm)} nm to ${iataCity(destCode)}${etaStr ? ` · ETA ${etaStr}` : ''}` +
      `</div>`
  }

  const photoHtml = photoUrl
    ? `<img src="${photoUrl}" style="width:100%;height:110px;object-fit:cover;display:block">`
    : ''

  const logoHtml = aiata
    ? `<img src="https://www.gstatic.com/flights/airline_logos/70px/${aiata}.png" style="height:18px;width:auto;vertical-align:middle;margin-right:5px" onerror="this.style.display='none'">`
    : ''

  const badge = projected
    ? `<span style="color:#f59e0b;font-size:10px;font-weight:400"> ~ est</span>`
    : lostAt ? `<span style="color:#9ca3af;font-size:10px"> (last known)</span>` : ''

  const routeLine = (dep || arr)
    ? `<div style="color:#374151;font-size:12px;margin-bottom:4px">${iataCity(dep)} to ${iataCity(arr)}</div>`
    : ''

  let syriaLine = ''
  if (arrSyria && a.arr_time_utc) {
    const [h, m] = a.arr_time_utc.split(':').map(Number)
    const localH = (h + 3) % 24
    const localTime = `${String(localH).padStart(2,'0')}:${String(m).padStart(2,'0')}`
    const ap  = a.arr_iata ?? ''
    const dur = a.duration_min
      ? ` · ${Math.floor(a.duration_min/60)}h${a.duration_min%60>0?` ${a.duration_min%60}m`:''}`
      : ''
    syriaLine = `<div style="color:#16a34a;font-size:11px;margin-top:4px">→ ${ap}  ${localTime} local${dur}</div>`
  }

  const delayLine = fs?.dep_delay_min != null && Math.abs(fs.dep_delay_min) >= 2
    ? `<div style="color:${fs.dep_delay_min > 0 ? '#f97316' : '#16a34a'};font-size:11px;margin-top:2px">${fs.dep_delay_min > 0 ? `+${fs.dep_delay_min}` : fs.dep_delay_min} min delay</div>`
    : ''

  const lostLine = lostAt && !projected
    ? `<div style="color:#ef4444;font-size:11px;margin-top:3px">⚠ Signal lost ${new Date(lostAt).toLocaleTimeString()}</div>`
    : ''

  const drLine = projected && lostAt
    ? `<div style="color:#9ca3af;font-size:10px;margin-top:2px">Dead reckoning from ${new Date(lostAt).toLocaleTimeString()}</div>`
    : ''

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-width:200px">
    ${photoHtml}
    <div style="padding:9px 13px 11px">
      <div style="display:flex;align-items:center;margin-bottom:3px">
        ${logoHtml}<b style="font-size:14px">${callsign}</b>${badge}
        ${acType ? `<span style="margin-left:auto;color:#9ca3af;font-size:11px">${acType}</span>` : ''}
      </div>
      ${routeLine}
      <div style="color:#6b7280;font-size:12px">${alt} · ${spd}</div>
      ${distLine}${syriaLine}${delayLine}${lostLine}${drLine}
    </div>
  </div>`
}

function buildSchedulePopup(e: ScheduleEntry, arrived = false, fs?: FlightStatus | null, fraction?: number): string {
  const isSyria = AIRPORT_COORDS[e.arr_iata] != null
  const acType  = fs?.aircraft_type ?? null
  const aiata   = airlineIataFor(e.callsign, fs)

  const logoHtml = aiata
    ? `<img src="https://www.gstatic.com/flights/airline_logos/70px/${aiata}.png" style="height:18px;width:auto;vertical-align:middle;margin-right:5px" onerror="this.style.display='none'">`
    : ''

  // Delay lines
  const depDelay = fs?.dep_delay_min != null && Math.abs(fs.dep_delay_min) >= 2
    ? `<div style="color:${fs.dep_delay_min > 0 ? '#f97316' : '#16a34a'};font-size:11px;margin-top:2px">Dep ${fs.dep_delay_min > 0 ? `+${fs.dep_delay_min}` : fs.dep_delay_min} min</div>`
    : ''
  const arrDelayMin = fs?.arr_delay_min != null ? fs.arr_delay_min
    : (fs?.revised_arr_utc && fs?.scheduled_arr_utc
        ? Math.round((new Date(fs.revised_arr_utc).getTime() - new Date(fs.scheduled_arr_utc).getTime()) / 60_000)
        : null)
  const arrDelay = arrDelayMin != null && Math.abs(arrDelayMin) >= 2
    ? `<div style="color:${arrDelayMin > 0 ? '#f97316' : '#16a34a'};font-size:11px;margin-top:2px">Arr ${arrDelayMin > 0 ? `+${arrDelayMin}` : arrDelayMin} min</div>`
    : ''

  const bestArrISO   = fs?.actual_arr_utc ?? fs?.revised_arr_utc ?? null
  const bestArrLabel = fs?.actual_arr_utc ? 'Arrived' : fs?.revised_arr_utc ? 'Revised arr' : null

  const toLocal = (iso: string) => {
    const d = new Date(iso)
    const h = (d.getUTCHours() + 3) % 24
    return `${String(h).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`
  }
  const schedToLocal = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    return `${String((h + 3) % 24).padStart(2,'0')}:${String(m).padStart(2,'0')}`
  }

  const routeLine = `<div style="color:#374151;font-size:12px;margin-bottom:4px">${iataCity(e.dep_iata)} to ${iataCity(e.arr_iata)}</div>`

  if (arrived && isSyria && e.arr_time_utc && e.arr_time_utc !== '—') {
    const localTime = bestArrISO ? toLocal(bestArrISO) : schedToLocal(e.arr_time_utc)
    return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-width:200px;padding:9px 13px 11px">
      <div style="display:flex;align-items:center;margin-bottom:3px">
        ${logoHtml}<b style="font-size:14px">${e.callsign}</b>
        ${acType ? `<span style="margin-left:auto;color:#9ca3af;font-size:11px">${acType}</span>` : ''}
      </div>
      ${routeLine}
      <div style="color:#16a34a;font-size:11px">Arrived ${e.arr_iata} ~${localTime} local</div>
      ${depDelay}${arrDelay}
      <div style="color:#9ca3af;font-size:10px;margin-top:3px">Schedule-estimated · no live signal</div>
    </div>`
  }

  let syriaLine = ''
  if (isSyria && e.arr_time_utc && e.arr_time_utc !== '—') {
    const schedLocal = schedToLocal(e.arr_time_utc)
    const dur = e.duration_min
      ? ` · ${Math.floor(e.duration_min/60)}h${e.duration_min%60>0?` ${e.duration_min%60}m`:''}`
      : ''
    syriaLine = `<div style="color:#16a34a;font-size:11px;margin-top:4px">→ ${e.arr_iata}  ${schedLocal} local${dur}</div>`
    if (bestArrISO && bestArrLabel) {
      syriaLine += `<div style="color:#f59e0b;font-size:11px;margin-top:1px">${bestArrLabel} ${toLocal(bestArrISO)} local</div>`
    }
  }

  const pct = (fraction != null && fraction > 0 && fraction < 1 && !arrived)
    ? Math.round(Math.min(fraction, 1) * 100)
    : null
  const progressHtml = pct != null
    ? `<div style="margin-top:6px">
        <div style="height:3px;background:#1f2937;border-radius:2px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#0284c7,#06b6d4);border-radius:2px"></div>
        </div>
      </div>`
    : ''

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-width:200px;padding:9px 13px 11px">
    <div style="display:flex;align-items:center;margin-bottom:3px">
      ${logoHtml}<b style="font-size:14px">${e.callsign}</b>
      <span style="color:#f59e0b;font-size:10px;font-weight:400;margin-left:4px"> ~ est</span>
      ${acType ? `<span style="margin-left:auto;color:#9ca3af;font-size:11px">${acType}</span>` : ''}
    </div>
    ${routeLine}
    ${syriaLine}
    ${depDelay}${arrDelay}
    ${progressHtml}
    <div style="color:#9ca3af;font-size:10px;margin-top:3px">Schedule projection · no signal yet</div>
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
  return {
    callsign,
    iata_number:    fs?.flight_number  ?? callsign,
    airline_iata:   fs?.airline_iata   ?? airlineIataFor(callsign),
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

export default function Map({ embed = false }: { embed?: boolean }) {
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
  // Last confirmed ADS-B lat/lon per callsign — kept alive through stale hand-off
  // so the schedule overlay GPS floor still works after trackedRef is cleared.
  const lastADSBPosRef    = useRef<Record<string, { lat: number; lon: number; lostAt: number }>>({})
  // Last kinematic state per callsign — kept for schedule-overlay DR fallback.
  const kinematicStateRef = useRef<Record<string, KinematicState>>({})
  // One FlightPredictor per callsign — handles hybrid DR + smooth recovery for ADS-B entries.
  const predictorRef      = useRef<Record<string, FlightPredictor>>({})

  const [error, setError] = useState<string | null>(null)

  // ── Map init ────────────────────────────────────────────────────────────────
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
        zoomControl: !embed,
      })
      if (embed) {
        map.fitBounds([[22, 26], [43, 62]])
      }
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19,
      }).addTo(map)
      mapInstanceRef.current = map

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
      const L   = (await import('leaflet')).default
      const map = mapInstanceRef.current
      if (!map) return

      const now = Date.now()

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
              // FR24 cache: lostAt = fr24Ts so DR advances between 5-min refreshes
              trackedRef.current[cs] = { a, lostAt: fr24Ts || now - 30_000, isFr24: true }
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
            flightStatusRef.current[cs] = {
              callsign:          cs,
              status:            actual_arr_utc ? 'Arrived' : 'Departed',
              actual_dep_utc:    actual_dep_utc ?? existing?.actual_dep_utc ?? null,
              actual_arr_utc:    actual_arr_utc ?? existing?.actual_arr_utc ?? null,
              scheduled_dep_utc: existing?.scheduled_dep_utc ?? null,
              scheduled_arr_utc: existing?.scheduled_arr_utc ?? null,
              revised_dep_utc:   existing?.revised_dep_utc   ?? null,
              revised_arr_utc:   revised_arr_utc ?? existing?.revised_arr_utc ?? null,
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

          setError(data.warn ? 'Feed degraded' : null)
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
            track_deg:   typeof a.track === 'number' ? a.track : 0,
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
                const arrC2 = schedEntry ? ALL_AIRPORT_COORDS[schedEntry.arr_iata] : null
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
                const dc2   = ALL_AIRPORT_COORDS[depI2]
                const ac3   = ALL_AIRPORT_COORDS[arrI2]
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
                const arrC2  = schedEntry ? ALL_AIRPORT_COORDS[schedEntry.arr_iata] : null
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
                    const depC2 = ALL_AIRPORT_COORDS[schedEntry?.dep_iata ?? a.dep_iata ?? ''] ?? null
                    const arrC2 = ALL_AIRPORT_COORDS[schedEntry?.arr_iata ?? a.arr_iata ?? ''] ?? null
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
                const dc   = ALL_AIRPORT_COORDS[depI]
                const ac2  = ALL_AIRPORT_COORDS[arrI]
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
            const arrC = ALL_AIRPORT_COORDS[schedEntry.arr_iata]
            if (arrC) { dispLat = arrC[0]; dispLon = arrC[1]; arrSnapped = true; projected = true }
          } else if (a.gs && a.track &&
              (schedEntry == null || fraction !== null ||
               (typeof a.alt_baro === 'number' && a.alt_baro > 2_000))) {
            // Fallback: kinematic dead-reckoning
            const projDistKm = a.gs * 1.852 * (elapsed / 3_600_000)
            const destDists  = [a.dep_iata, a.arr_iata]
              .filter((ap): ap is string => !!ap && !!AIRPORT_COORDS[ap])
              .map(ap => greatCircleKm(a.lat, a.lon, AIRPORT_COORDS[ap][0], AIRPORT_COORDS[ap][1]))
            const minDestKm = destDists.length ? Math.min(...destDists) : Infinity
            if (projDistKm < minDestKm) {
              const [pLat, pLon] = projectPosition(a.lat, a.lon, a.track, a.gs, elapsed)
              dispLat = pLat; dispLon = pLon; projected = true
            } else {
              const bestAp = ([a.arr_iata, a.dep_iata].find(ap => ap && AIRPORT_COORDS[ap]) ?? '')
              if (AIRPORT_COORDS[bestAp]) {
                const apC = AIRPORT_COORDS[bestAp]
                const bearingToAp = (Math.atan2(
                  (apC[1] - a.lon) * Math.cos(a.lat * Math.PI / 180),
                  apC[0] - a.lat
                ) * 180 / Math.PI + 360) % 360
                const headingDiff = Math.abs(((a.track - bearingToAp) + 180) % 360 - 180)
                if (headingDiff < 90) { dispLat = apC[0]; dispLon = apC[1]; arrSnapped = true }
              }
            }
          }
        }

        // On-ground: pin to arrival airport
        if (isOnGround && !arrSnapped) {
          const se_ = scheduleRef.current.find(e => e.callsign === cs)
          const arrIata_ = se_?.arr_iata ?? a.arr_iata ?? null
          const arrC_ = arrIata_ ? ALL_AIRPORT_COORDS[arrIata_] : null
          if (arrC_) { dispLat = arrC_[0]; dispLon = arrC_[1]; arrSnapped = true; projected = true }
        }

        // Confirmed arrival snap
        if (!arrSnapped) {
          const fsFix = flightStatusRef.current[cs]
          if (fsFix?.actual_arr_utc && now - new Date(fsFix.actual_arr_utc).getTime() < 4 * 3_600_000) {
            const seFix = scheduleRef.current.find(e => e.callsign === cs)
            const arrFix = (seFix ? ALL_AIRPORT_COORDS[seFix.arr_iata] : null)
                        ?? (fsFix.arr_iata ? ALL_AIRPORT_COORDS[fsFix.arr_iata] : null)
                        ?? (a.arr_iata    ? ALL_AIRPORT_COORDS[a.arr_iata]    : null)
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
                const depC = ALL_AIRPORT_COORDS[se.dep_iata]
                if (depC) { dispLat = depC[0]; dispLon = depC[1] }
              } else if (sinceArr2 > 0 && sinceArr2 <= 90 * 60) {
                const arrC = ALL_AIRPORT_COORDS[se.arr_iata]
                if (arrC) { dispLat = arrC[0]; dispLon = arrC[1]; arrSnapped = true }
              }
            }
          }
        }

        const staleLabel    = arrSnapped ? `${cs}\nARRIVED` : cs
        const isEstimated   = projected && !arrSnapped
        const icon    = planeIcon(L, dispTrack, true, arrSnapped, staleLabel, isAlp, isEstimated)
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

        if (markersRef.current[cs]) {
          markersRef.current[cs].setLatLng([dispLat, dispLon])
          markersRef.current[cs].setIcon(icon)
          if (!embed) markersRef.current[cs].setPopupContent(popup)
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
            m.bindPopup(popup, { className: 'fp-popup' })
          }
          markersRef.current[cs] = m
        }

        // Fetch aircraft photo once per registration.
        // Runs two sources in parallel: Wikimedia Commons (high-res, selective coverage)
        // and Planespotters (broad coverage, 421×280 max). Whichever resolves with a URL
        // fires first; Wikimedia also upgrades the cache if it arrives later.
        if (regDr && !photoRequestedRef.current.has(regDr)) {
          photoRequestedRef.current.add(regDr)
          const capturedCS      = cs
          const capturedA       = a
          const capturedLostAt  = lostAt

          const emitPhoto = (url: string) => {
            // Only upgrade if this URL is better (Wikimedia) or cache is still null
            if (!photoCacheRef.current[regDr] || url.includes('wikimedia')) {
              photoCacheRef.current[regDr] = url
            }
            if (markersRef.current[capturedCS]) {
              const fsNow = flightStatusRef.current[capturedCS]
              markersRef.current[capturedCS].setPopupContent(
                buildPopup(capturedA, capturedLostAt > 0 ? capturedLostAt : undefined, false, fsNow, url)
              )
            }
            if (selectedCSRef.current === capturedCS) {
              const fsNow = flightStatusRef.current[capturedCS]
              const seNow = scheduleRef.current.find(e => e.callsign === capturedCS) ?? null
              rnPost({ type: 'SELECT', flight: buildEmbedFlight(capturedCS, seNow, fsNow ?? null, url) })
            }
          }

          // Planespotters — broad coverage, ~421×280px max
          fetch(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(regDr)}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => {
              const url: string | null = d?.photos?.[0]?.thumbnail_large?.src ?? d?.photos?.[0]?.thumbnail?.src ?? null
              if (url && !photoCacheRef.current[regDr]) emitPhoto(url)
              else if (!url) photoCacheRef.current[regDr] = null
            })
            .catch(() => { if (!photoCacheRef.current[regDr]) photoCacheRef.current[regDr] = null })

          // Wikimedia Commons — selective coverage, up to 960px wide (Retina-quality)
          fetch(
            `https://commons.wikimedia.org/w/api.php?action=query&list=search` +
            `&srsearch=${encodeURIComponent(regDr + ' aircraft')}&srnamespace=6&srlimit=5&format=json&origin=*`
          )
            .then(r => r.ok ? r.json() : null)
            .then(async searchData => {
              const files: any[] = searchData?.query?.search ?? []
              const hit = files.find(f => f.title.toUpperCase().includes(regDr.toUpperCase()))
              if (!hit) return
              const imgRes = await fetch(
                `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(hit.title)}` +
                `&prop=imageinfo&iiprop=url&iiurlwidth=960&format=json&origin=*`
              )
              const imgData = imgRes.ok ? await imgRes.json() : null
              const pages = imgData?.query?.pages ?? {}
              const thumbUrl: string | null = (Object.values(pages)[0] as any)?.imageinfo?.[0]?.thumburl ?? null
              if (thumbUrl) emitPhoto(thumbUrl)
            })
            .catch(() => {})
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
      const activeSchedKeys = new Set<string>()

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

        const depC = ALL_AIRPORT_COORDS[dep_iata]
        const arrC = ALL_AIRPORT_COORDS[arr_iata]
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
        const icon  = planeIcon(L, track, true, arrived, label, isAlp, !arrived)
        const popup = buildSchedulePopup(entry, arrived, fs, fPos)

        activeSchedKeys.add(callsign)

        if (schedMarkersRef.current[callsign]) {
          schedMarkersRef.current[callsign].setLatLng([lat, lon])
          schedMarkersRef.current[callsign].setIcon(icon)
          if (!embed) schedMarkersRef.current[callsign].setPopupContent(popup)
        } else {
          const m = L.marker([lat, lon], { icon }).addTo(map)
          if (embed) {
            m.on('click', () => {
              const fs  = flightStatusRef.current[callsign]
              const reg = fs?.aircraft_reg ?? null
              const ph  = reg ? photoCacheRef.current[reg] ?? null : null
              selectedCSRef.current = callsign
              rnPost({ type: 'SELECT', flight: buildEmbedFlight(callsign, entry, fs ?? null, ph) })
            })
          } else {
            m.bindPopup(popup, { className: 'fp-popup' })
          }
          schedMarkersRef.current[callsign] = m
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

      // Broadcast in-air count to React Native
      if (embed) {
        const total = Object.keys(markersRef.current).length + Object.keys(schedMarkersRef.current).length
        rnPost({ type: 'COUNT', count: total })
      }
    }

    fetchAndUpdate()
    const interval = setInterval(fetchAndUpdate, 10_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="relative w-full h-full">
      <div ref={mapRef} className="w-full h-full" />
      {error && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] bg-gray-900/90 backdrop-blur px-4 py-2 rounded-full text-sm border border-gray-700">
          <span className="text-red-400">{error}</span>
        </div>
      )}
    </div>
  )
}

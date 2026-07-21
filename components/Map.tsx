'use client'

import 'leaflet/dist/leaflet.css'
import { useEffect, useRef, useState } from 'react'

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
  syria_airports: string[]
  arr_time_utc:   string | null
  duration_min:   number | null
  dep_syria:      boolean
  arr_syria:      boolean
  seen_at?: string
  stale?:   boolean
}

interface LastKnown {
  a: Aircraft
  lostAt: number
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
  IST: [40.9769, 28.8146],
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

function buildPopup(a: Aircraft, lostAt?: number, projected?: boolean, fs?: FlightStatus | null): string {
  const callsign  = (a.flight ?? '').trim() || a.hex
  const alt       = typeof a.alt_baro === 'number' ? `${Math.round(a.alt_baro).toLocaleString()} ft` : '—'
  const spd       = a.gs ? `${Math.round(a.gs)} kts` : '—'
  const syriaAps  = a.syria_airports ?? []
  // Only highlight the Syrian connection when the flight is arriving IN Syria.
  // Outbound flights (dep_syria=true, arr_syria=false) depart FROM Syria — showing
  // "→ DAM" would imply DAM is the destination, which is wrong and confusing.
  const arrSyria  = a.arr_syria && syriaAps.length > 0

  // Prefer AeroDataBox aircraft info over FR24 when available
  const acType    = fs?.aircraft_type ?? a.t ?? null
  const acReg     = fs?.aircraft_reg  ?? a.r ?? null

  let scheduleLine = ''
  if (arrSyria && a.arr_time_utc) {
    const [h, m]    = a.arr_time_utc.split(':').map(Number)
    const localH    = (h + 3) % 24
    const localTime = `${String(localH).padStart(2,'0')}:${String(m).padStart(2,'0')}`
    const arrAp     = syriaAps[0] ?? ''
    const dur       = a.duration_min
      ? ` &nbsp;·&nbsp; ${Math.floor(a.duration_min/60)}h${a.duration_min%60>0?` ${a.duration_min%60}m`:''}`
      : ''
    scheduleLine = `<br/><span style="color:#4ade80;font-size:11px">Arrives ${arrAp} ${localTime}${dur}</span>`
  }

  const delayLine = fs?.dep_delay_min != null && Math.abs(fs.dep_delay_min) >= 2
    ? `<br/><span style="color:${fs.dep_delay_min > 0 ? '#f97316' : '#4ade80'};font-size:11px">${fs.dep_delay_min > 0 ? `+${fs.dep_delay_min}` : fs.dep_delay_min} min delay</span>`
    : ''

  const badge = projected
    ? ' <span style="color:#fbbf24;font-size:10px">~ estimated</span>'
    : lostAt ? ' <span style="color:#9ca3af;font-size:10px">(last known)</span>' : ''

  return `<div style="font-family:monospace;font-size:12px;line-height:1.7">
    <b>${callsign}</b>${badge}<br/>
    ${acType ? `Type: ${acType}<br/>` : ''}${acReg ? `Reg: ${acReg}<br/>` : ''}
    Alt: ${alt} &nbsp; Speed: ${spd}
    ${arrSyria ? `<br/><span style="color:#16a34a;font-weight:bold">→ ${syriaAps.join(', ')}</span>${scheduleLine}` : ''}
    ${delayLine}
    ${lostAt && !projected ? `<br/><span style="color:#ef4444;font-size:11px">⚠ Signal lost ${new Date(lostAt).toLocaleTimeString()}</span>` : ''}
    ${projected && lostAt ? `<br/><span style="color:#6b7280;font-size:10px">Dead reckoning from ${new Date(lostAt).toLocaleTimeString()}</span>` : ''}
  </div>`
}

function buildSchedulePopup(e: ScheduleEntry, arrived = false, fs?: FlightStatus | null): string {
  const isSyria = AIRPORT_COORDS[e.arr_iata] != null
  const acType  = fs?.aircraft_type ?? null
  const acReg   = fs?.aircraft_reg  ?? null
  const acLine  = (acType || acReg)
    ? `<br/>${acType ?? ''}${acType && acReg ? ' · ' : ''}${acReg ?? ''}`
    : ''

  // Delay lines — prefer arr delay for arrivals, dep delay for departures
  const depDelay = fs?.dep_delay_min != null && Math.abs(fs.dep_delay_min) >= 2
    ? `<br/><span style="color:${fs.dep_delay_min > 0 ? '#f97316' : '#4ade80'};font-size:11px">Dep ${fs.dep_delay_min > 0 ? `+${fs.dep_delay_min}` : fs.dep_delay_min} min</span>`
    : ''
  const arrDelayMin = fs?.arr_delay_min != null ? fs.arr_delay_min
    : (fs?.revised_arr_utc && fs?.scheduled_arr_utc
        ? Math.round((new Date(fs.revised_arr_utc).getTime() - new Date(fs.scheduled_arr_utc).getTime()) / 60_000)
        : null)
  const arrDelay = arrDelayMin != null && Math.abs(arrDelayMin) >= 2
    ? `<br/><span style="color:${arrDelayMin > 0 ? '#f97316' : '#4ade80'};font-size:11px">Arr ${arrDelayMin > 0 ? `+${arrDelayMin}` : arrDelayMin} min</span>`
    : ''

  // Best arrival time: actual → revised → scheduled (converted to local Syria +3)
  const bestArrISO = fs?.actual_arr_utc ?? fs?.revised_arr_utc ?? null
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

  if (arrived && isSyria && e.arr_time_utc && e.arr_time_utc !== '—') {
    const localTime = bestArrISO ? toLocal(bestArrISO) : schedToLocal(e.arr_time_utc)
    return `<div style="font-family:monospace;font-size:12px;line-height:1.7">
      <b>${e.callsign}</b> <span style="color:#9ca3af;font-size:10px">landed</span><br/>
      ${e.dep_iata} → ${e.arr_iata}${acLine}
      <br/><span style="color:#4ade80;font-size:11px">Arrived ${e.arr_iata} ~${localTime} local</span>
      ${depDelay}${arrDelay}
      <br/><span style="color:#6b7280;font-size:10px">Schedule-estimated · no live signal</span>
    </div>`
  }

  let arrLine = ''
  if (isSyria && e.arr_time_utc && e.arr_time_utc !== '—') {
    const schedLocal = schedToLocal(e.arr_time_utc)
    const dur = e.duration_min
      ? ` &nbsp;·&nbsp; ${Math.floor(e.duration_min/60)}h${e.duration_min%60>0?` ${e.duration_min%60}m`:''}`
      : ''
    arrLine = `<br/><span style="color:#4ade80;font-size:11px">Sched ${e.arr_iata} ${schedLocal}${dur}</span>`
    if (bestArrISO && bestArrLabel) {
      const revisedLocal = toLocal(bestArrISO)
      arrLine += `<br/><span style="color:#fbbf24;font-size:11px">${bestArrLabel} ${revisedLocal} local</span>`
    }
  }
  return `<div style="font-family:monospace;font-size:12px;line-height:1.7">
    <b>${e.callsign}</b> <span style="color:#fbbf24;font-size:10px">~ estimated</span><br/>
    ${e.dep_iata} → ${e.arr_iata}${acLine}
    ${isSyria ? `<br/><span style="color:#16a34a;font-weight:bold">→ ${e.arr_iata}</span>${arrLine}` : ''}
    ${depDelay}${arrDelay}
    <br/><span style="color:#6b7280;font-size:10px">Schedule projection · no signal yet</span>
  </div>`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Map() {
  const mapRef          = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstanceRef  = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef      = useRef<Record<string, any>>({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const linesRef        = useRef<Record<string, any[]>>({})
  const lastKnownRef    = useRef<Record<string, LastKnown>>({})
  // Schedule-based projected markers (key = callsign)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schedMarkersRef = useRef<Record<string, any>>({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schedLinesRef   = useRef<Record<string, any[]>>({})
  const scheduleRef     = useRef<ScheduleEntry[]>([])
  const routePathsRef   = useRef<Record<string, Waypoint[]>>({})
  const flightStatusRef = useRef<Record<string, FlightStatus>>({})

  const [count, setCount]           = useState(0)
  const [lastUpdate, setLastUpdate] = useState('')
  const [error, setError]           = useState<string | null>(null)

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
      const map = L.map(mapRef.current!, { center: [33.0, 42.0], zoom: 6 })
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19,
      }).addTo(map)
      mapInstanceRef.current = map
    })
    return () => { mapInstanceRef.current?.remove(); mapInstanceRef.current = null }
  }, [])

  // ── Load schedule + route paths once on mount ───────────────────────────────
  useEffect(() => {
    fetch('/api/schedule')
      .then(r => r.json())
      .then(d => {
        if (!d.ok) return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scheduleRef.current = (d.rows as any[])
          .filter(r => r.dep_time_utc !== '—' && r.arr_time_utc !== '—' && r.duration_min > 0)
          .map(r => ({
            callsign:     r.broadcast_callsign as string,
            dep_iata:     r.dep_iata           as string,
            arr_iata:     r.arr_iata           as string,
            dep_time_utc: (r.dep_time_utc as string).slice(0, 5),
            arr_time_utc: (r.arr_time_utc as string).slice(0, 5),
            duration_min: r.duration_min       as number,
            days_of_week: r.days_of_week       as string[],
          }))
          .filter(e => e.callsign && e.dep_iata && e.arr_iata)
      })
      .catch(() => {})

    const loadStatus = () =>
      fetch('/api/aerodatabox/status')
        .then(r => r.json())
        .then(d => { if (d.ok) flightStatusRef.current = d.status })
        .catch(() => {})
    loadStatus()
    // Refresh every 5 min so webhook-pushed status updates are picked up
    // without requiring a full page reload.
    const statusInterval = setInterval(loadStatus, 5 * 60_000)

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
    return () => clearInterval(statusInterval)
  }, [])

  // ── Poll loop ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const fetchAndUpdate = async () => {
      const L   = (await import('leaflet')).default
      const map = mapInstanceRef.current
      if (!map) return

      const now = Date.now()

      // ── Fetch live feed ───────────────────────────────────────────────────
      let liveAircraft: Aircraft[] = []
      let fr24CallsignsList: string[] = []
      try {
        const res  = await fetch('/api/airspace')
        const data = await res.json()
        if (data.ok) {
          if (data.from_db) {
            for (const a of data.aircraft as Aircraft[]) {
              if (!lastKnownRef.current[a.hex]) {
                const lostAt = a.seen_at ? new Date(a.seen_at).getTime() : now - 5 * 60_000
                lastKnownRef.current[a.hex] = { a, lostAt }
              }
            }
            setError('Live feed down — showing last known positions')
          } else {
            // fr24Ts is when FR24 data was fetched; FR24 aircraft use this as lostAt
            // so dead-reckoning advances their position between 5-min cache refreshes.
            const fr24Ts: number = data.fr24Ts ?? 0
            fr24CallsignsList = (data.fr24Callsigns ?? []) as string[]
            for (const a of data.aircraft as Aircraft[]) {
              const isFr24 = (a as any).fr24 === true
              if (a.stale) {
                if (!lastKnownRef.current[a.hex]) {
                  const lostAt = a.seen_at ? new Date(a.seen_at).getTime() : now - 60_000
                  lastKnownRef.current[a.hex] = { a, lostAt }
                }
              } else if (isFr24) {
                // Route FR24 aircraft through last-known DR so position advances
                // between cache refreshes, and always refresh their lostAt to fr24Ts.
                lastKnownRef.current[a.hex] = { a, lostAt: fr24Ts || now - 30_000 }
              } else {
                liveAircraft.push(a)
              }
            }
            setError(data.warn ? 'Feed degraded' : null)
          }
        } else {
          setError(data.warn ?? 'feed error')
        }
      } catch (e) {
        setError(String(e))
      }

      // Stale aircraft (from DB last-seen cache) are routed through the last-known
      // loop so they get full DR + canonical path rejoin, not a frozen marker.
      const seen = new Set(liveAircraft.filter(a => !a.stale).map(a => a.hex))

      // Collect callsigns already covered by real data (live or last-known).
      // Stale and pre-departure last-known entries are excluded so ESTIMATED can show.
      // FR24 callsigns are seeded explicitly — this is the authoritative signal that
      // overrides ESTIMATED regardless of Vercel instance cache state.
      const realCallsigns = new Set<string>(
        liveAircraft.filter(a => !a.stale).map(a => (a.flight ?? '').trim()).filter(Boolean)
      )
      for (const cs of fr24CallsignsList) {
        if (cs) realCallsigns.add(cs)
      }
      // After this many ms without a new signal, drop the stale entry from
      // realCallsigns so the schedule-projected ESTIMATED marker can take over.
      // 3 min ≈ 3 poll cycles — long enough to absorb brief coverage gaps,
      // short enough that a genuinely lost signal shows ESTIMATED quickly.
      const STALE_HAND_OFF_MS = 3 * 60_000

      for (const entry of Object.values(lastKnownRef.current)) {
        const cs = (entry.a.flight ?? '').trim()
        if (!cs) continue
        // FR24 aircraft suppress ESTIMATED while actively tracked. Once FR24 stops
        // refreshing lostAt (plane left our airspace feed range), hand off to ESTIMATED
        // after 30 min so flights to DXB/KWI/etc. don't vanish mid-route.
        const FR24_HAND_OFF_MS = 30 * 60_000
        if ((entry.a as any).fr24 && now - entry.lostAt < FR24_HAND_OFF_MS) {
          realCallsigns.add(cs)
          continue
        }
        const sched = scheduleRef.current.find(e => e.callsign === cs)
        if (sched && isFlightActiveNow(sched.dep_time_utc, sched.arr_time_utc, sched.days_of_week, now) === null) {
          // Pre-departure or post-arrival+freeze: let ESTIMATED take over
          continue
        }
        // Hand off to ESTIMATED once the stale position is old enough.
        if (now - entry.lostAt > STALE_HAND_OFF_MS) continue
        realCallsigns.add(cs)
      }

      // ── Live markers ──────────────────────────────────────────────────────
      for (const a of liveAircraft) {
        if (a.stale) {
          // Stale DB entries: preserve lostAt so elapsed grows, then hand off to
          // the last-known loop below for DR + canonical path rejoin.
          const prev = lastKnownRef.current[a.hex]
          // Never overwrite an FR24 entry with a stale DB row — the DB row is often
          // just a shadow of the FR24 upsert and must not strip the fr24 flag or
          // reset the position anchor that keeps ESTIMATED suppressed.
          if (!(prev && (prev.a as any).fr24)) {
            // Use seen_at from DB as lostAt anchor so the 6h TTL doesn't reset on
            // every poll cycle when no prior entry exists.
            const staleLostAt = prev?.lostAt || (a.seen_at ? new Date(a.seen_at).getTime() : now - 5 * 60_000)
            lastKnownRef.current[a.hex] = { a, lostAt: staleLostAt }
          }
          // Remove any old live marker so the last-known loop owns the rendering.
          markersRef.current[a.hex]?.remove()
          delete markersRef.current[a.hex]
          linesRef.current[a.hex]?.forEach((l: any) => l.remove())
          delete linesRef.current[a.hex]
          continue
        }
        lastKnownRef.current[a.hex] = { a, lostAt: 0 }

        const airports = a.syria_airports ?? []
        const isSyria  = airports.length > 0

        // Hide non-Syria flights — remove any existing marker and skip
        if (!isSyria) {
          markersRef.current[a.hex]?.remove()
          delete markersRef.current[a.hex]
          linesRef.current[a.hex]?.forEach((l: any) => l.remove())
          delete linesRef.current[a.hex]
          continue
        }

        const callsign = (a.flight ?? '').trim()
        const isAlp    = airports.includes('ALP')
        const icon     = planeIcon(L, bestHeading(a), isSyria, false, isSyria && callsign ? callsign : undefined, isAlp)
        const popup    = buildPopup({ ...a, syria_airports: airports }, undefined, false, flightStatusRef.current[callsign])

        if (markersRef.current[a.hex]) {
          markersRef.current[a.hex].setLatLng([a.lat, a.lon])
          markersRef.current[a.hex].setIcon(icon)
          markersRef.current[a.hex].setPopupContent(popup)
        } else {
          markersRef.current[a.hex] = L.marker([a.lat, a.lon], { icon }).addTo(map).bindPopup(popup)
        }

        linesRef.current[a.hex]?.forEach((l: any) => l.remove())
        // Only draw the green line to Syria airport when the flight is ARRIVING at Syria.
        // Departing flights (dep_syria=true, arr_syria=false) already left the airport —
        // drawing a line back toward it would look like the plane is flying the wrong way.
        linesRef.current[a.hex] = []
      }

      // ── Last-known / dead-reckoning markers ───────────────────────────────
      // Deduplicate by callsign: when multiple hexes share a callsign (e.g. a stale
      // DB entry AND a FR24 entry), keep only the best one — FR24 wins, then newest lostAt.
      const bestHexForCallsign: Record<string, string> = {}
      for (const hex of Object.keys(lastKnownRef.current)) {
        if (seen.has(hex)) continue
        const entry = lastKnownRef.current[hex]
        if ((entry.a.syria_airports ?? []).length === 0) continue
        const cs = (entry.a.flight ?? '').trim()
        if (!cs) continue
        const existing = bestHexForCallsign[cs]
        if (!existing) { bestHexForCallsign[cs] = hex; continue }
        const existEntry = lastKnownRef.current[existing]
        const isBetter = ((entry.a as any).fr24 && !(existEntry.a as any).fr24)
          || (entry.lostAt > existEntry.lostAt && !((existEntry.a as any).fr24 && !(entry.a as any).fr24))
        if (isBetter) {
          markersRef.current[existing]?.remove(); delete markersRef.current[existing]
          linesRef.current[existing]?.forEach((l: any) => l.remove()); delete linesRef.current[existing]
          bestHexForCallsign[cs] = hex
        } else {
          markersRef.current[hex]?.remove(); delete markersRef.current[hex]
          linesRef.current[hex]?.forEach((l: any) => l.remove()); delete linesRef.current[hex]
        }
      }

      for (const hex of Object.keys(lastKnownRef.current)) {
        if (seen.has(hex)) continue

        const entry = lastKnownRef.current[hex]
        if (entry.lostAt === 0) entry.lostAt = now

        // Hide non-Syria flights
        if ((entry.a.syria_airports ?? []).length === 0) {
          markersRef.current[hex]?.remove()
          delete markersRef.current[hex]
          linesRef.current[hex]?.forEach((l: any) => l.remove())
          delete linesRef.current[hex]
          continue
        }

        // Skip the loser hex for this callsign — dedup already cleaned it up
        const cs0 = (entry.a.flight ?? '').trim()
        if (cs0 && bestHexForCallsign[cs0] !== hex) continue

        // If a LIVE ADS-B entry at a different hex covers this callsign, suppress the
        // DR marker — avoids a duplicate "ESTIMATED" icon alongside the live plane.
        // Do NOT suppress when only FR24 cache covers it: the plane may have just
        // landed and dropped from the ADS-B feed; we still want to show ARRIVED.
        if (cs0 && liveAircraft.some(la => !la.stale && (la.flight ?? '').trim() === cs0 && la.hex !== hex)) {
          markersRef.current[hex]?.remove()
          delete markersRef.current[hex]
          linesRef.current[hex]?.forEach((l: any) => l.remove())
          delete linesRef.current[hex]
          continue
        }

        // If this callsign has been handed off to the ESTIMATED schedule marker
        // (not in realCallsigns and has a schedule entry), remove the stale marker
        // so both don't render simultaneously.
        if (cs0 && !realCallsigns.has(cs0) && scheduleRef.current.some(e => e.callsign === cs0)) {
          markersRef.current[hex]?.remove()
          delete markersRef.current[hex]
          linesRef.current[hex]?.forEach((l: any) => l.remove())
          delete linesRef.current[hex]
          continue
        }

        const ttl = STALE_TTL_SYRIA_MS
        if (now - entry.lostAt > ttl) {
          markersRef.current[hex]?.remove()
          delete markersRef.current[hex]
          linesRef.current[hex]?.forEach((l: any) => l.remove())
          delete linesRef.current[hex]
          delete lastKnownRef.current[hex]
          continue
        }

        const { a }      = entry
        const aps        = a.syria_airports ?? []
        const isSyria    = aps.length > 0
        const elapsed    = now - entry.lostAt
        // True when the aircraft is on the ground — landed early before the schedule
        // fraction reaches 1.0.  Used to show ARRIVED and extend the expiry window.
        const isOnGround = (a.alt_baro === 'ground' || (typeof a.alt_baro === 'number' && a.alt_baro < 500))
                        && (typeof a.gs === 'number' ? a.gs < 50 : false)

        let dispLat = a.lat, dispLon = a.lon, dispTrack = bestHeading(a)
        let projected = false, arrSnapped = false

        // Expire markers past scheduled arrival window.
        // Live-then-lost (not on ground): 15 min (let ESTIMATED take over quickly).
        // Stale DB aircraft or on-ground non-stale: 90 min (full ARRIVED window).
        if (isSyria && a.arr_time_utc) {
          const d = new Date(now)
          const nowSec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()
          const [ah, am] = a.arr_time_utc.split(':').map(Number)
          const sinceArr = (nowSec - (ah * 3600 + am * 60) + 86400) % 86400
          const maxSinceArr = (a.stale || isOnGround) ? 90 * 60 : 15 * 60
          if (sinceArr > maxSinceArr && sinceArr < 22 * 3600) {
            // Guard against midnight-crossing routes (e.g. dep 21:15, arr 00:51):
            // sinceArr wraps to ~21h which looks "past arrival" but the flight is
            // still airborne. isFlightActiveNow handles overnight correctly — skip
            // removal if the flight is still in progress (fraction 0–1).
            const cs_ = (a.flight ?? '').trim()
            const se_ = cs_ ? scheduleRef.current.find(e => e.callsign === cs_) : null
            const activeFrac = se_
              ? isFlightActiveNow(se_.dep_time_utc, se_.arr_time_utc, se_.days_of_week, now)
              : null
            if (activeFrac !== null && activeFrac <= 1.0) {
              // Flight still active — don't expire
            } else {
              markersRef.current[hex]?.remove()
              delete markersRef.current[hex]
              linesRef.current[hex]?.forEach((l: any) => l.remove())
              delete linesRef.current[hex]
              delete lastKnownRef.current[hex]
              continue
            }
          }
        }

        const isFR24Entry = (entry.a as any).fr24 === true
        if (isSyria && (elapsed > 30_000 || isFR24Entry)) {
          // ── Path-based rejoin ───────────────────────────────────────────────
          const cs = (a.flight ?? '').trim()
          const schedEntry = scheduleRef.current.find(e => e.callsign === cs)
          const pathKey = schedEntry ? `${schedEntry.dep_iata}|${schedEntry.arr_iata}` : ''
          const wps = pathKey ? routePathsRef.current[pathKey] : undefined
          const fraction = schedEntry
            ? isFlightActiveNow(schedEntry.dep_time_utc, schedEntry.arr_time_utc, schedEntry.days_of_week, now)
            : null

          if (wps?.length && fraction !== null) {
            // Cap at 0.97 so the icon never overshoots destination via waypoints that
            // extend slightly past the airport — same cap used in the ESTIMATED path.
            const clampedF = Math.min(0.97, fraction)
            const [timeLat, timeLon] = interpolatePath(wps, clampedF)
            const distKm = greatCircleKm(a.lat, a.lon, timeLat, timeLon)
            const SNAP_KM = 80  // ~43 NM — if within this, follow time-based fraction

            // Pre-validate kinematic DR: if the projected position moves the plane
            // further from its destination than the fix itself, the cached track is
            // stale (e.g. captured mid-turn). In that case fall through to path-following.
            let drLat = a.lat, drLon = a.lon, drValid = false
            if (isFR24Entry && typeof a.gs === 'number' && a.gs > 50 && typeof a.track === 'number') {
              ;[drLat, drLon] = projectPosition(a.lat, a.lon, a.track, a.gs, elapsed)
              const arrC2  = schedEntry ? ALL_AIRPORT_COORDS[schedEntry.arr_iata] : null
              const distFix = arrC2 ? greatCircleKm(a.lat,  a.lon,  arrC2[0], arrC2[1]) : 0
              const distDR  = arrC2 ? greatCircleKm(drLat, drLon, arrC2[0], arrC2[1]) : 0
              drValid = !arrC2 || distDR <= distFix + 20   // 20 km tolerance for minor overshoot
            }

            let useF = clampedF
            if (fraction > 1.0) {
              // Post-arrival freeze: snap to arrival airport coords, not the last
              // waypoint (which may extend past the airport and cause overshoot).
              const arrC2 = schedEntry ? ALL_AIRPORT_COORDS[schedEntry.arr_iata] : null
              if (arrC2) { dispLat = arrC2[0]; dispLon = arrC2[1] }
              else { dispLat = timeLat; dispLon = timeLon }
              dispTrack = bearingFromPath(wps, Math.min(1, fraction))
              arrSnapped = true
            } else if (isFR24Entry && drValid) {
              // Kinematic DR — track is consistent with destination direction.
              dispLat = drLat; dispLon = drLon
              dispTrack = a.track ?? 0
            } else if (isFR24Entry) {
              // Path-following fallback for FR24 stale entries: walk forward from the
              // nearest route point + elapsed fraction. Not used for ADS-B stale entries
              // whose last fix may be wrong (MLAT error, hex mismatch) — those fall
              // through to the time-based schedule fraction below.
              const liveF = nearestPathFraction(wps, a.lat, a.lon)
              let elapsedFrac = 0
              if (schedEntry && schedEntry.duration_min > 0) {
                elapsedFrac = elapsed / (schedEntry.duration_min * 60_000)
              } else {
                const depC2 = schedEntry ? ALL_AIRPORT_COORDS[schedEntry.dep_iata] : null
                const arrC2 = schedEntry ? ALL_AIRPORT_COORDS[schedEntry.arr_iata] : null
                if (depC2 && arrC2) {
                  const routeKm = greatCircleKm(depC2[0], depC2[1], arrC2[0], arrC2[1])
                  if (routeKm > 0) {
                    const speedKts = (a.gs && a.gs > 50) ? a.gs : 450
                    const distKm2  = speedKts * 1.852 * (elapsed / 3_600_000)
                    elapsedFrac    = distKm2 / routeKm
                  }
                }
              }
              useF = Math.min(0.97, liveF + elapsedFrac)
              const [pathLat, pathLon] = interpolatePath(wps, useF)
              dispLat = pathLat; dispLon = pathLon
              dispTrack = bearingFromPath(wps, useF)
            } else {
              dispLat = timeLat; dispLon = timeLon
              dispTrack = bearingFromPath(wps, useF)
            }
            projected = true
          } else if (schedEntry && fraction !== null && fraction > 1.0) {
            // No route path but flight arrived — snap to arrival airport coords
            const arrC = ALL_AIRPORT_COORDS[schedEntry.arr_iata]
            if (arrC) { dispLat = arrC[0]; dispLon = arrC[1]; arrSnapped = true; projected = true }
          } else if (a.gs && a.track && (schedEntry == null || fraction !== null)) {
            // ── Fallback: kinematic dead-reckoning ──────────────────────────
            const projDistKm = a.gs * 1.852 * (elapsed / 3_600_000)
            const destDists  = aps
              .filter(ap => AIRPORT_COORDS[ap])
              .map(ap => greatCircleKm(a.lat, a.lon, AIRPORT_COORDS[ap][0], AIRPORT_COORDS[ap][1]))
            const minDestKm = destDists.length ? Math.min(...destDists) : Infinity

            if (projDistKm < minDestKm) {
              const [pLat, pLon] = projectPosition(a.lat, a.lon, a.track, a.gs, elapsed)
              dispLat = pLat; dispLon = pLon; projected = true
            } else {
              const bestAp = aps.find(ap => AIRPORT_COORDS[ap]) ?? ''
              if (AIRPORT_COORDS[bestAp]) {
                const apC = AIRPORT_COORDS[bestAp]
                const bearingToAp = (Math.atan2(
                  (apC[1] - a.lon) * Math.cos(a.lat * Math.PI / 180),
                  apC[0] - a.lat
                ) * 180 / Math.PI + 360) % 360
                const headingDiff = Math.abs(((a.track - bearingToAp) + 180) % 360 - 180)
                if (headingDiff < 90) {
                  dispLat = apC[0]; dispLon = apC[1]; arrSnapped = true
                }
              }
            }
          }
        }

        // On-ground non-stale aircraft (landed early, before schedule fraction hits 1.0):
        // pin to arrival airport and show ARRIVED badge.
        if (isSyria && isOnGround && !arrSnapped) {
          const cs_ = (a.flight ?? '').trim()
          const se_ = scheduleRef.current.find(e => e.callsign === cs_)
          const arrC_ = se_ ? ALL_AIRPORT_COORDS[se_.arr_iata] : null
          if (arrC_) { dispLat = arrC_[0]; dispLon = arrC_[1]; arrSnapped = true; projected = true }
        }

        // Confirmed arrival from AeroDataBox or FR24: snap to arrival airport even
        // when the flight landed early (fraction < 1.0 during path-following).
        // 4 h recency guard prevents yesterday's row from triggering today's flight.
        if (isSyria && !arrSnapped) {
          const csFix = (a.flight ?? '').trim()
          const fsFix = csFix ? flightStatusRef.current[csFix] : null
          if (fsFix?.actual_arr_utc && (now - new Date(fsFix.actual_arr_utc).getTime() < 4 * 3_600_000)) {
            const seFix  = scheduleRef.current.find(e => e.callsign === csFix)
            const arrFix = seFix ? ALL_AIRPORT_COORDS[seFix.arr_iata] : null
            if (arrFix) { dispLat = arrFix[0]; dispLon = arrFix[1]; arrSnapped = true }
          }
        }

        // Stale un-projected aircraft: determine whether pre-departure or post-arrival
        // by comparing the raw clock, not just isFlightActiveNow (which returns null
        // for both states). Pre-departure → park at dep airport. Post-arrival (within
        // 90 min) → snap to arr airport with ARRIVED. Beyond 90 min the expiry check
        // above already removes the marker, so no further action needed.
        if (a.stale && !projected && isSyria) {
          const scs = (a.flight ?? '').trim()
          const se  = scheduleRef.current.find(e => e.callsign === scs)
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
                // Genuinely pre-departure: park at departure airport
                const depC = ALL_AIRPORT_COORDS[se.dep_iata]
                if (depC) { dispLat = depC[0]; dispLon = depC[1] }
              } else if (sinceArr2 > 0 && sinceArr2 <= 90 * 60) {
                // Post-arrival within 90 min: show at arrival airport as ARRIVED
                const arrC = ALL_AIRPORT_COORDS[se.arr_iata]
                if (arrC) { dispLat = arrC[0]; dispLon = arrC[1]; arrSnapped = true }
              }
              // sinceArr > 90 min: expiry check at top of loop already removed marker
            }
          }
        }

        const cs        = (a.flight ?? '').trim()
        const staleLabel = isSyria && cs
          ? (arrSnapped ? `${cs}\nARRIVED` : cs)
          : undefined
        const isEstimatedStale = projected && !arrSnapped
        const icon       = planeIcon(L, dispTrack, isSyria, !isSyria || arrSnapped, staleLabel, aps.includes('ALP'), isEstimatedStale)
        const popup      = buildPopup({ ...a, syria_airports: aps }, entry.lostAt, projected, flightStatusRef.current[cs])

        // Smooth-blend toward the DR target so that when a fresh FR24 fix arrives
        // at a position slightly different from what DR predicted, the marker
        // transitions gradually instead of jumping (55% per 10s poll cycle).
        if (isFR24Entry && !arrSnapped && markersRef.current[hex]) {
          const p = markersRef.current[hex].getLatLng()
          const BLEND = 0.55
          dispLat = p.lat + BLEND * (dispLat - p.lat)
          dispLon = p.lng + BLEND * (dispLon - p.lng)
        }

        if (markersRef.current[hex]) {
          markersRef.current[hex].setLatLng([dispLat, dispLon])
          markersRef.current[hex].setIcon(icon)
          markersRef.current[hex].setPopupContent(popup)
        } else {
          markersRef.current[hex] = L.marker([dispLat, dispLon], { icon }).addTo(map).bindPopup(popup)
        }

        linesRef.current[hex]?.forEach((l: any) => l.remove())
        linesRef.current[hex] = []
      }

      // ── Schedule-based projection (no signal at all) ───────────────────────
      const activeSchedKeys = new Set<string>()

      for (const entry of scheduleRef.current) {
        const { callsign, dep_iata, arr_iata, dep_time_utc, arr_time_utc, duration_min, days_of_week } = entry

        // If we have real data for this callsign, clear any schedule marker and skip
        if (realCallsigns.has(callsign)) {
          if (schedMarkersRef.current[callsign]) {
            schedMarkersRef.current[callsign].remove()
            delete schedMarkersRef.current[callsign]
            schedLinesRef.current[callsign]?.forEach((l: any) => l.remove())
            delete schedLinesRef.current[callsign]
          }
          continue
        }

        let fraction = isFlightActiveNow(dep_time_utc, arr_time_utc, days_of_week, now)
        const fs = flightStatusRef.current[callsign]

        // Only show ESTIMATED when we have confirmed airborne status from ADB/FR24
        // (actual_dep_utc set, or status is an in-flight state). Pure schedule-window
        // matches without any data confirmation are suppressed to avoid phantom flights.
        const AIRBORNE = new Set(['En Route', 'Departed', 'Approaching'])
        if (fraction !== null) {
          if (!fs) {
            // No ADB/FR24 status — check if ADS-B itself confirms airborne.
            // alt_baro > 2,000ft within the last hour is unambiguous proof of departure,
            // so we activate the schedule-fraction ESTIMATED marker without needing a
            // flight_status record (which ADB/FR24 sync may have missed).
            const adsbAirborne = Object.values(lastKnownRef.current).some(e =>
              (e.a.flight ?? '').trim() === callsign &&
              typeof e.a.alt_baro === 'number' && e.a.alt_baro > 2_000 &&
              (now - e.lostAt) < 60 * 60_000
            )
            if (!adsbAirborne) fraction = null
            // else: ADS-B confirms airborne — keep schedule fraction as-is
          } else if (!fs.actual_dep_utc && !AIRBORNE.has(fs.status)) {
            // Known flight but not yet confirmed departed
            fraction = null
          } else if (fs.actual_dep_utc && duration_min > 0) {
            // Confirmed airborne — refine position using actual departure time
            const elapsedMs = now - new Date(fs.actual_dep_utc).getTime()
            fraction = elapsedMs > 0 ? Math.min(1.2, elapsedMs / (duration_min * 60_000)) : null
          } else if (duration_min > 0) {
            // Airborne status confirmed but no actual_dep_utc yet.
            // Back-calculate implied departure from revised_arr_utc if available,
            // so a delayed flight isn't placed far ahead using the scheduled dep time.
            const impliedDepMs = fs.revised_arr_utc
              ? new Date(fs.revised_arr_utc).getTime() - duration_min * 60_000
              : null
            if (impliedDepMs) {
              const elapsedMs = now - impliedDepMs
              fraction = elapsedMs > 0 ? Math.min(1.2, elapsedMs / (duration_min * 60_000)) : null
            }
            // else: no revised_arr_utc either — keep raw schedule fraction as last resort
          }
        }

        // Confirmed early landing: flight touched down before schedule window closed.
        // actual_arr_utc within 4 h prevents yesterday's row from firing on today's flight.
        if (fraction !== null && fraction < 1.0 && fs?.actual_arr_utc
            && (now - new Date(fs.actual_arr_utc).getTime() < 4 * 3_600_000)) {
          fraction = 1.1
        }

        if (fraction === null) {
          // Flight not active — remove stale scheduled marker
          if (schedMarkersRef.current[callsign]) {
            schedMarkersRef.current[callsign].remove()
            delete schedMarkersRef.current[callsign]
            schedLinesRef.current[callsign]?.forEach((l: any) => l.remove())
            delete schedLinesRef.current[callsign]
          }
          continue
        }

        const depC = ALL_AIRPORT_COORDS[dep_iata]
        const arrC = ALL_AIRPORT_COORDS[arr_iata]
        if (!depC || !arrC) continue

        // Schedule fraction >= 1.0 means past scheduled arrival.
        // Only confirm ARRIVED when AeroDataBox has actual_arr_utc — otherwise
        // a ghost appears at the airport every day the schedule window reopens.
        const schedPastArrival = fraction >= 1.0
        const adbConfirmedArr  = !!(fs?.actual_arr_utc)
        const arrived = schedPastArrival && adbConfirmedArr
        // If schedule says flight is over but AeroDataBox hasn't confirmed arrival,
        // suppress the marker entirely — don't show ESTIMATED past scheduled arrival.
        if (schedPastArrival && !adbConfirmedArr) {
          if (schedMarkersRef.current[callsign]) {
            schedMarkersRef.current[callsign].remove()
            delete schedMarkersRef.current[callsign]
            schedLinesRef.current[callsign]?.forEach((l: any) => l.remove())
            delete schedLinesRef.current[callsign]
          }
          continue
        }
        const f = arrived ? 1 : fraction
        // Cap rendered position to 97% of route so the icon never overshoots the
        // destination airport when waypoints extend slightly past the nominal coords.
        const fPos = Math.min(f, 0.97)

        const wps = routePathsRef.current[`${dep_iata}|${arr_iata}`]
        const [lat, lon] = wps?.length
          ? interpolatePath(wps, fPos)
          : slerpGreatCircle(depC[0], depC[1], arrC[0], arrC[1], fPos)
        const track = wps?.length
          ? bearingFromPath(wps, fPos)
          : bearingAlongPath(depC[0], depC[1], arrC[0], arrC[1], fPos)
        const isSyria    = AIRPORT_COORDS[arr_iata] != null || AIRPORT_COORDS[dep_iata] != null
        const label      = arrived ? `${callsign}\nARRIVED` : callsign

        const icon  = planeIcon(L, track, isSyria, arrived, label, dep_iata === 'ALP' || arr_iata === 'ALP', !arrived)
        const popup = buildSchedulePopup(entry, arrived, fs)

        activeSchedKeys.add(callsign)

        if (schedMarkersRef.current[callsign]) {
          schedMarkersRef.current[callsign].setLatLng([lat, lon])
          schedMarkersRef.current[callsign].setIcon(icon)
          schedMarkersRef.current[callsign].setPopupContent(popup)
        } else {
          schedMarkersRef.current[callsign] = L.marker([lat, lon], { icon }).addTo(map).bindPopup(popup)
        }

        // No route line for arrived flights; clear any existing line
        schedLinesRef.current[callsign]?.forEach((l: any) => l.remove())
        schedLinesRef.current[callsign] = []
      }

      // Remove schedule markers that are no longer active
      for (const cs of Object.keys(schedMarkersRef.current)) {
        if (!activeSchedKeys.has(cs)) {
          schedMarkersRef.current[cs].remove()
          delete schedMarkersRef.current[cs]
          schedLinesRef.current[cs]?.forEach((l: any) => l.remove())
          delete schedLinesRef.current[cs]
        }
      }

      setCount(liveAircraft.length)
      setLastUpdate(new Date().toLocaleTimeString())
    }

    fetchAndUpdate()
    const interval = setInterval(fetchAndUpdate, 10_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="relative w-full h-full">
      <div ref={mapRef} className="w-full h-full" />
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] bg-gray-900/90 backdrop-blur px-4 py-2 rounded-full text-sm flex items-center gap-4 border border-gray-700">
        <span className="text-blue-400 font-mono font-bold">{count} aircraft</span>
        {lastUpdate && <span className="text-gray-400">Updated {lastUpdate}</span>}
        {error && <span className="text-red-400">{error}</span>}
      </div>
    </div>
  )
}

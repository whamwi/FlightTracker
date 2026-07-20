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
  t: string | null
  r: string | null
  syria_airports: string[]
  arr_time_utc:   string | null
  duration_min:   number | null
  seen_at?: string
  stale?:   boolean
}

interface LastKnown {
  a: Aircraft
  lostAt: number
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

// ── Icon & popup ──────────────────────────────────────────────────────────────

function planeIcon(L: typeof import('leaflet'), track: number, syria: boolean, stale: boolean, label?: string) {
  const size    = syria ? 40 : 30
  const color   = stale ? '#9ca3af' : syria ? '#16a34a' : '#1d4ed8'
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
    const textColor = stale ? '#9ca3af' : '#4ade80'
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

function buildPopup(a: Aircraft, lostAt?: number, projected?: boolean): string {
  const callsign  = (a.flight ?? '').trim() || a.hex
  const alt       = typeof a.alt_baro === 'number' ? `${Math.round(a.alt_baro).toLocaleString()} ft` : '—'
  const spd       = a.gs ? `${Math.round(a.gs)} kts` : '—'
  const syriaAps  = a.syria_airports ?? []
  const syria     = syriaAps.length > 0

  let scheduleLine = ''
  if (syria && a.arr_time_utc) {
    const [h, m]    = a.arr_time_utc.split(':').map(Number)
    const localH    = (h + 3) % 24
    const localTime = `${String(localH).padStart(2,'0')}:${String(m).padStart(2,'0')}`
    const arrAp     = syriaAps[0] ?? ''
    const dur       = a.duration_min
      ? ` &nbsp;·&nbsp; ${Math.floor(a.duration_min/60)}h${a.duration_min%60>0?` ${a.duration_min%60}m`:''}`
      : ''
    scheduleLine = `<br/><span style="color:#4ade80;font-size:11px">Arrives ${arrAp} ${localTime}${dur}</span>`
  }

  const badge = projected
    ? ' <span style="color:#fbbf24;font-size:10px">~ estimated</span>'
    : lostAt ? ' <span style="color:#9ca3af;font-size:10px">(last known)</span>' : ''

  return `<div style="font-family:monospace;font-size:12px;line-height:1.7">
    <b>${callsign}</b>${badge}<br/>
    ${a.t ? `Type: ${a.t}<br/>` : ''}${a.r ? `Reg: ${a.r}<br/>` : ''}
    Alt: ${alt} &nbsp; Speed: ${spd}
    ${syria ? `<br/><span style="color:#16a34a;font-weight:bold">→ ${syriaAps.join(', ')}</span>${scheduleLine}` : ''}
    ${lostAt && !projected ? `<br/><span style="color:#ef4444;font-size:11px">⚠ Signal lost ${new Date(lostAt).toLocaleTimeString()}</span>` : ''}
    ${projected && lostAt ? `<br/><span style="color:#6b7280;font-size:10px">Dead reckoning from ${new Date(lostAt).toLocaleTimeString()}</span>` : ''}
  </div>`
}

function buildSchedulePopup(e: ScheduleEntry, arrived = false): string {
  const isSyria = AIRPORT_COORDS[e.arr_iata] != null
  if (arrived && isSyria && e.arr_time_utc && e.arr_time_utc !== '—') {
    const [h, m]    = e.arr_time_utc.split(':').map(Number)
    const localH    = (h + 3) % 24
    const localTime = `${String(localH).padStart(2,'0')}:${String(m).padStart(2,'0')}`
    return `<div style="font-family:monospace;font-size:12px;line-height:1.7">
      <b>${e.callsign}</b> <span style="color:#9ca3af;font-size:10px">landed</span><br/>
      ${e.dep_iata} → ${e.arr_iata}
      <br/><span style="color:#4ade80;font-size:11px">Arrived ${e.arr_iata} ~${localTime} local</span>
      <br/><span style="color:#6b7280;font-size:10px">Schedule-estimated · no live signal</span>
    </div>`
  }
  let arrLine = ''
  if (isSyria && e.arr_time_utc && e.arr_time_utc !== '—') {
    const [h, m]    = e.arr_time_utc.split(':').map(Number)
    const localH    = (h + 3) % 24
    const localTime = `${String(localH).padStart(2,'0')}:${String(m).padStart(2,'0')}`
    const dur       = e.duration_min
      ? ` &nbsp;·&nbsp; ${Math.floor(e.duration_min/60)}h${e.duration_min%60>0?` ${e.duration_min%60}m`:''}`
      : ''
    arrLine = `<br/><span style="color:#4ade80;font-size:11px">Arrives ${e.arr_iata} ${localTime}${dur}</span>`
  }
  return `<div style="font-family:monospace;font-size:12px;line-height:1.7">
    <b>${e.callsign}</b> <span style="color:#fbbf24;font-size:10px">~ estimated</span><br/>
    ${e.dep_iata} → ${e.arr_iata}
    ${isSyria ? `<br/><span style="color:#16a34a;font-weight:bold">→ ${e.arr_iata}</span>${arrLine}` : ''}
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
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map)
      mapInstanceRef.current = map
    })
    return () => { mapInstanceRef.current?.remove(); mapInstanceRef.current = null }
  }, [])

  // ── Load schedule once on mount ─────────────────────────────────────────────
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
            for (const a of data.aircraft as Aircraft[]) {
              if (a.stale) {
                if (!lastKnownRef.current[a.hex]) {
                  const lostAt = a.seen_at ? new Date(a.seen_at).getTime() : now - 60_000
                  lastKnownRef.current[a.hex] = { a, lostAt }
                }
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

      const seen = new Set(liveAircraft.map(a => a.hex))

      // Collect callsigns already covered by real data (live or last-known)
      const realCallsigns = new Set<string>([
        ...liveAircraft.map(a => (a.flight ?? '').trim()),
        ...Object.values(lastKnownRef.current).map(e => (e.a.flight ?? '').trim()),
      ])

      // ── Live markers ──────────────────────────────────────────────────────
      for (const a of liveAircraft) {
        lastKnownRef.current[a.hex] = { a, lostAt: 0 }

        const airports = a.syria_airports ?? []
        const isSyria  = airports.length > 0
        const callsign = (a.flight ?? '').trim()
        const icon     = planeIcon(L, a.track ?? 0, isSyria, false, isSyria && callsign ? callsign : undefined)
        const popup    = buildPopup({ ...a, syria_airports: airports })

        if (markersRef.current[a.hex]) {
          markersRef.current[a.hex].setLatLng([a.lat, a.lon])
          markersRef.current[a.hex].setIcon(icon)
          markersRef.current[a.hex].setPopupContent(popup)
        } else {
          markersRef.current[a.hex] = L.marker([a.lat, a.lon], { icon }).addTo(map).bindPopup(popup)
        }

        linesRef.current[a.hex]?.forEach((l: any) => l.remove())
        linesRef.current[a.hex] = isSyria
          ? airports.filter(ap => AIRPORT_COORDS[ap]).map(ap =>
              L.polyline([[a.lat, a.lon], AIRPORT_COORDS[ap]], {
                color: '#16a34a', weight: 1.5, dashArray: '6 8', opacity: 0.7,
              }).addTo(map))
          : []
      }

      // ── Last-known / dead-reckoning markers ───────────────────────────────
      for (const hex of Object.keys(lastKnownRef.current)) {
        if (seen.has(hex)) continue

        const entry = lastKnownRef.current[hex]
        if (entry.lostAt === 0) entry.lostAt = now

        const ttl = (entry.a.syria_airports ?? []).length > 0 ? STALE_TTL_SYRIA_MS : STALE_TTL_MS
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

        let dispLat = a.lat, dispLon = a.lon, projected = false, arrSnapped = false

        if (isSyria && a.gs && a.track && elapsed > 30_000) {
          const projDistKm = a.gs * 1.852 * (elapsed / 3_600_000)
          const destDists  = aps
            .filter(ap => AIRPORT_COORDS[ap])
            .map(ap => greatCircleKm(a.lat, a.lon, AIRPORT_COORDS[ap][0], AIRPORT_COORDS[ap][1]))
          const minDestKm = destDists.length ? Math.min(...destDists) : Infinity

          if (projDistKm < minDestKm) {
            const [pLat, pLon] = projectPosition(a.lat, a.lon, a.track, a.gs, elapsed)
            dispLat = pLat; dispLon = pLon; projected = true
          } else {
            // Dead reckoning would overshoot the Syria airport.
            // Check if the plane is heading TOWARD the airport (arriving) or AWAY (departing).
            const bestAp = aps.find(ap => AIRPORT_COORDS[ap]) ?? ''
            if (AIRPORT_COORDS[bestAp]) {
              const apC = AIRPORT_COORDS[bestAp]
              const bearingToAp = (Math.atan2(
                (apC[1] - a.lon) * Math.cos(a.lat * Math.PI / 180),
                apC[0] - a.lat
              ) * 180 / Math.PI + 360) % 360
              const headingDiff = Math.abs(((a.track - bearingToAp) + 180) % 360 - 180)

              if (headingDiff < 90) {
                // Heading toward airport → arrived
                dispLat = apC[0]; dispLon = apC[1]; arrSnapped = true
              }
              // Heading away → departing; freeze at last known position (no track projection)
            }
          }
        }

        const cs        = (a.flight ?? '').trim()
        const staleLabel = isSyria && cs
          ? (arrSnapped ? `${cs}\nARRIVED` : projected ? `${cs}\nESTIMATED` : cs)
          : undefined
        const icon       = planeIcon(L, a.track ?? 0, isSyria, !isSyria || arrSnapped, staleLabel)
        const popup      = buildPopup({ ...a, syria_airports: aps }, entry.lostAt, projected)

        if (markersRef.current[hex]) {
          markersRef.current[hex].setLatLng([dispLat, dispLon])
          markersRef.current[hex].setIcon(icon)
          markersRef.current[hex].setPopupContent(popup)
        } else {
          markersRef.current[hex] = L.marker([dispLat, dispLon], { icon }).addTo(map).bindPopup(popup)
        }

        linesRef.current[hex]?.forEach((l: any) => l.remove())
        const lines: ReturnType<typeof L.polyline>[] = []
        if (projected && (dispLat !== a.lat || dispLon !== a.lon)) {
          lines.push(L.polyline([[a.lat, a.lon], [dispLat, dispLon]], {
            color: '#6b7280', weight: 1.5, dashArray: '4 6', opacity: 0.55,
          }).addTo(map))
        }
        for (const ap of aps.filter(ap => AIRPORT_COORDS[ap])) {
          lines.push(L.polyline([[dispLat, dispLon], AIRPORT_COORDS[ap]], {
            color: '#16a34a', weight: 1.5, dashArray: '6 8', opacity: projected ? 0.4 : 0.3,
          }).addTo(map))
        }
        linesRef.current[hex] = lines
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

        const fraction = isFlightActiveNow(dep_time_utc, arr_time_utc, days_of_week, now)
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

        const arrived    = fraction >= 1.0
        const f          = arrived ? 1 : fraction
        const [lat, lon] = slerpGreatCircle(depC[0], depC[1], arrC[0], arrC[1], f)
        const track      = bearingAlongPath(depC[0], depC[1], arrC[0], arrC[1], f)
        const isSyria    = AIRPORT_COORDS[arr_iata] != null
        const label      = arrived ? `${callsign}\nARRIVED` : `${callsign}\nESTIMATED`

        const icon  = planeIcon(L, track, isSyria, arrived, label)
        const popup = buildSchedulePopup(entry, arrived)

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
        schedLinesRef.current[callsign] = arrived || !AIRPORT_COORDS[arr_iata]
          ? []
          : [L.polyline([[lat, lon], AIRPORT_COORDS[arr_iata]], {
              color: '#16a34a', weight: 1.5, dashArray: '6 8', opacity: 0.6,
            }).addTo(map)]
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

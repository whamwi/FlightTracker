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
}

interface LastKnown {
  a: Aircraft
  lostAt: number    // ms timestamp when it left the feed
}

const AIRPORT_COORDS: Record<string, [number, number]> = {
  DAM: [33.4114, 36.5156],
  ALP: [36.1807, 37.2244],
}

const STALE_TTL_MS = 30 * 60 * 1000

function planeIcon(L: typeof import('leaflet'), track: number, syria: boolean, stale: boolean) {
  const size    = syria ? 40 : 30
  const color   = stale ? '#9ca3af' : syria ? '#16a34a' : '#1d4ed8'
  const opacity = stale ? 0.5 : 1
  return L.divIcon({
    className: '',
    html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"
      style="transform:rotate(${track}deg);opacity:${opacity};filter:drop-shadow(0 1px 3px rgba(0,0,0,0.4))">
      <path fill="${color}" stroke="white" stroke-width="${syria && !stale ? 0.4 : 0.6}"
        d="M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
    </svg>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function buildPopup(a: Aircraft, lostAt?: number): string {
  const callsign = (a.flight ?? '').trim() || a.hex
  const alt      = typeof a.alt_baro === 'number' ? `${Math.round(a.alt_baro).toLocaleString()} ft` : '—'
  const spd      = a.gs ? `${Math.round(a.gs)} kts` : '—'
  const syria    = a.syria_airports.length > 0

  return `<div style="font-family:monospace;font-size:12px;line-height:1.7">
    <b>${callsign}</b>${lostAt ? ' <span style="color:#9ca3af;font-size:10px">(last known)</span>' : ''}<br/>
    ${a.t ? `Type: ${a.t}<br/>` : ''}${a.r ? `Reg: ${a.r}<br/>` : ''}
    Alt: ${alt} &nbsp; Speed: ${spd}
    ${syria ? `<br/><span style="color:#16a34a;font-weight:bold">→ ${a.syria_airports.join(', ')}</span>` : ''}
    ${lostAt ? `<br/><span style="color:#ef4444;font-size:11px">⚠ Signal lost ${new Date(lostAt).toLocaleTimeString()}</span>` : ''}
  </div>`
}

export default function Map() {
  const mapRef         = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstanceRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef     = useRef<Record<string, any>>({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const linesRef       = useRef<Record<string, any[]>>({})
  const lastKnownRef   = useRef<Record<string, LastKnown>>({})

  const [count, setCount]           = useState(0)
  const [lastUpdate, setLastUpdate] = useState('')
  const [error, setError]           = useState<string | null>(null)

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

  useEffect(() => {
    const fetchAndUpdate = async () => {
      const L   = (await import('leaflet')).default
      const map = mapInstanceRef.current
      if (!map) return

      // ── Fetch live feed ───────────────────────────────────────────────────
      let liveAircraft: Aircraft[] = []
      try {
        const res  = await fetch('/api/airspace')
        const data = await res.json()
        if (data.ok) {
          liveAircraft = data.aircraft
          setError(null)
        } else {
          setError(data.error ?? 'feed error')
        }
      } catch (e) {
        setError(String(e))
      }

      const now  = Date.now()
      const seen = new Set(liveAircraft.map(a => a.hex))

      // ── Update / create active markers ───────────────────────────────────
      for (const a of liveAircraft) {
        lastKnownRef.current[a.hex] = { a, lostAt: 0 }   // 0 = active (not lost)

        const isSyria = a.syria_airports.length > 0
        const icon    = planeIcon(L, a.track ?? 0, isSyria, false)
        const popup   = buildPopup(a)

        if (markersRef.current[a.hex]) {
          markersRef.current[a.hex].setLatLng([a.lat, a.lon])
          markersRef.current[a.hex].setIcon(icon)
          markersRef.current[a.hex].setPopupContent(popup)
        } else {
          markersRef.current[a.hex] = L.marker([a.lat, a.lon], { icon })
            .addTo(map).bindPopup(popup)
        }

        // Redraw dashed lines to Syria airports
        linesRef.current[a.hex]?.forEach((l: any) => l.remove())
        linesRef.current[a.hex] = isSyria
          ? a.syria_airports.filter(ap => AIRPORT_COORDS[ap]).map(ap =>
              L.polyline([[a.lat, a.lon], AIRPORT_COORDS[ap]], {
                color: '#16a34a', weight: 1.5, dashArray: '6 8', opacity: 0.7,
              }).addTo(map))
          : []
      }

      // ── Handle missing aircraft ───────────────────────────────────────────
      for (const hex of Object.keys(lastKnownRef.current)) {
        if (seen.has(hex)) continue

        const entry = lastKnownRef.current[hex]

        // Stamp lostAt on first miss
        if (entry.lostAt === 0) entry.lostAt = now

        // Past retention — clean up
        if (now - entry.lostAt > STALE_TTL_MS) {
          markersRef.current[hex]?.remove()
          delete markersRef.current[hex]
          linesRef.current[hex]?.forEach((l: any) => l.remove())
          delete linesRef.current[hex]
          delete lastKnownRef.current[hex]
          continue
        }

        // Still within TTL — show last known position
        const { a } = entry
        const isSyria = a.syria_airports.length > 0
        const icon    = planeIcon(L, a.track ?? 0, isSyria, true)
        const popup   = buildPopup(a, entry.lostAt)

        if (markersRef.current[hex]) {
          markersRef.current[hex].setIcon(icon)
          markersRef.current[hex].setPopupContent(popup)
        } else {
          // Marker was never created (first poll it was already missing) — create it
          markersRef.current[hex] = L.marker([a.lat, a.lon], { icon })
            .addTo(map).bindPopup(popup)
          // Keep lines dimmed
          linesRef.current[hex]?.forEach((l: any) => l.setStyle({ opacity: 0.3 }))
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

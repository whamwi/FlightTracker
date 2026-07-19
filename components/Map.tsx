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
}

export default function Map() {
  const mapRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstanceRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef = useRef<Record<string, any>>({})
  const [count, setCount] = useState(0)
  const [lastUpdate, setLastUpdate] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    // Dynamically import Leaflet to avoid SSR issues
    import('leaflet').then(L => {
      // Clear any leftover Leaflet state from React Strict Mode double-mount
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (mapRef.current as any)._leaflet_id

      // Fix default marker icons
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (L.Icon.Default.prototype as any)._getIconUrl
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      })

      const map = L.map(mapRef.current!, {
        center: [33.0, 42.0],
        zoom: 6,
        zoomControl: true,
      })

      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '© OpenStreetMap © CARTO',
        subdomains: 'abcd',
        maxZoom: 19,
      }).addTo(map)

      mapInstanceRef.current = map
    })

    return () => {
      mapInstanceRef.current?.remove()
      mapInstanceRef.current = null
    }
  }, [])

  useEffect(() => {
    const fetchAndUpdate = async () => {
      try {
        const res = await fetch('/api/airspace')
        const data = await res.json()
        if (!data.ok) { setError(data.error); return }
        setError(null)

        const L = (await import('leaflet')).default
        const map = mapInstanceRef.current
        if (!map) return

        const seen = new Set<string>()

        for (const a of data.aircraft as Aircraft[]) {
          seen.add(a.hex)
          const callsign = (a.flight ?? a.hex ?? '').trim()
          const alt = typeof a.alt_baro === 'number' ? `${Math.round(a.alt_baro).toLocaleString()} ft` : '—'
          const spd = a.gs ? `${Math.round(a.gs)} kts` : '—'
          const popup = `
            <div style="font-family:monospace;font-size:12px;line-height:1.6">
              <b>${callsign || a.hex}</b><br/>
              ${a.t ? `Type: ${a.t}<br/>` : ''}
              ${a.r ? `Reg: ${a.r}<br/>` : ''}
              Alt: ${alt}<br/>
              Speed: ${spd}
            </div>`

          const rotation = a.track ?? 0
          const icon = L.divIcon({
            className: '',
            html: `<div style="transform:rotate(${rotation}deg);font-size:18px;line-height:1;filter:drop-shadow(0 0 3px rgba(0,150,255,0.8))">✈</div>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          })

          if (markersRef.current[a.hex]) {
            const marker = markersRef.current[a.hex]
            marker.setLatLng([a.lat, a.lon])
            marker.setIcon(icon)
            marker.setPopupContent(popup)
          } else {
            const marker = L.marker([a.lat, a.lon], { icon })
              .addTo(map)
              .bindPopup(popup)
            markersRef.current[a.hex] = marker
          }
        }

        // Remove stale markers
        for (const hex of Object.keys(markersRef.current)) {
          if (!seen.has(hex)) {
            markersRef.current[hex].remove()
            delete markersRef.current[hex]
          }
        }

        setCount(data.aircraft.length)
        setLastUpdate(new Date().toLocaleTimeString())
      } catch (e) {
        setError(String(e))
      }
    }

    fetchAndUpdate()
    const interval = setInterval(fetchAndUpdate, 10_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="relative w-full h-full">
      <div ref={mapRef} className="w-full h-full" />

      {/* Status bar */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] bg-gray-900/90 backdrop-blur px-4 py-2 rounded-full text-sm flex items-center gap-4 border border-gray-700">
        <span className="text-blue-400 font-mono font-bold">{count} aircraft</span>
        {lastUpdate && <span className="text-gray-400">Updated {lastUpdate}</span>}
        {error && <span className="text-red-400">{error}</span>}
      </div>
    </div>
  )
}

import { useState, useEffect, useCallback } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native'
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps'

const API = 'https://flighttracker-sy.vercel.app/api/airspace'

type Aircraft = {
  hex: string
  flight: string
  lat: number
  lon: number
  track: number | null
  t: string | null
  board_match: boolean
  dep_iata: string | null
  arr_iata: string | null
  iata_number: string | null
  actual_dep_utc: string | null
  actual_arr_utc: string | null
  dep_delay_min: number | null
  airline_iata: string | null
  alt_baro: number | 'ground' | null
  gs: number | null
}

const CITY: Record<string, string> = {
  DAM: 'Damascus', ALP: 'Aleppo', LTK: 'Latakia', DEZ: 'Deir ez-Zor',
  DXB: 'Dubai', SHJ: 'Sharjah', AUH: 'Abu Dhabi',
  IST: 'Istanbul', SAW: 'Istanbul', ESB: 'Ankara',
  JED: 'Jeddah', RUH: 'Riyadh', KWI: 'Kuwait',
  AMM: 'Amman', BEY: 'Beirut', BGW: 'Baghdad',
  MCT: 'Muscat', DOH: 'Doha', CAI: 'Cairo',
  BAH: 'Bahrain', TBS: 'Tbilisi', GYD: 'Baku',
}
const city = (iata: string | null) => (iata && CITY[iata]) ? CITY[iata] : (iata ?? '—')

function fmtUtc3(iso: string | null) {
  if (!iso) return null
  const d = new Date(iso)
  const h = (d.getUTCHours() + 3) % 24
  return `${String(h).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function planeColor(f: Aircraft): string {
  const isAlp = (f.arr_iata === 'ALP' || f.dep_iata === 'ALP') && !!f.actual_arr_utc
  if (isAlp) return '#f97316'          // orange — ALP arrival
  if (f.board_match) return '#16a34a'  // green  — Syria-tracked
  return '#9ca3af'                     // grey   — untracked traffic
}

export default function MapTab() {
  const [flights, setFlights] = useState<Aircraft[]>([])
  const [selected, setSelected] = useState<Aircraft | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch(API)
      const json = await res.json()
      setFlights((json.aircraft ?? []).filter((a: Aircraft) => a.lat && a.lon))
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const tracked = flights.filter(f => f.board_match)

  return (
    <View style={{ flex: 1 }}>
      <MapView
        style={{ flex: 1 }}
        provider={PROVIDER_DEFAULT}
        mapType="standard"
        initialRegion={{
          latitude: 33,
          longitude: 40,
          latitudeDelta: 20,
          longitudeDelta: 30,
        }}
        onPress={() => setSelected(null)}
      >
        {/* Render untracked first (bottom layer), then tracked on top */}
        {flights.filter(f => !f.board_match).map(f => (
          <Marker
            key={f.hex}
            coordinate={{ latitude: f.lat, longitude: f.lon }}
            onPress={e => { e.stopPropagation(); setSelected(f) }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
          >
            <Text style={{
              fontSize: 13,
              color: '#9ca3af',
              opacity: 0.6,
              transform: [{ rotate: `${(f.track ?? 0) - 45}deg` }],
            }}>✈</Text>
          </Marker>
        ))}

        {flights.filter(f => f.board_match).map(f => {
          const isArrived = !!f.actual_arr_utc
          const isAlp = (f.arr_iata === 'ALP' || f.dep_iata === 'ALP') && isArrived
          const color = planeColor(f)
          const isSelected = selected?.hex === f.hex
          const label = f.iata_number ?? f.flight?.trim()
          const heading = f.track ?? 0

          return (
            <Marker
              key={f.hex}
              coordinate={{ latitude: f.lat, longitude: f.lon }}
              onPress={e => { e.stopPropagation(); setSelected(f) }}
              anchor={{ x: 0.5, y: 0.5 }}
              tracksViewChanges={false}
            >
              <View style={styles.markerWrap}>
                <Text style={{
                  fontSize: isSelected ? 28 : 24,
                  color: isSelected ? '#f59e0b' : color,
                  transform: [{ rotate: `${heading - 45}deg` }],
                }}>✈</Text>
                {label ? (
                  <View style={styles.labelWrap}>
                    <Text style={[styles.labelText, { color: isAlp ? '#f97316' : '#4ade80' }]}>
                      {label}
                    </Text>
                    {isArrived && (
                      <Text style={styles.arrivedText}>ARRIVED</Text>
                    )}
                  </View>
                ) : null}
              </View>
            </Marker>
          )
        })}
      </MapView>

      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color="#16a34a" />
        </View>
      )}

      {/* Badge */}
      <View style={styles.badge}>
        <Text style={styles.badgeText}>
          {tracked.length} tracked · {flights.length} in airspace
        </Text>
      </View>

      {/* Popup */}
      {selected && (
        <View style={styles.popup}>
          <TouchableOpacity style={styles.closeBtn} onPress={() => setSelected(null)}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>

          <Text style={styles.flightNum}>{selected.iata_number ?? selected.flight?.trim()}</Text>
          <Text style={styles.route}>{city(selected.dep_iata)} → {city(selected.arr_iata)}</Text>

          <View style={styles.popupRow}>
            <View>
              <Text style={styles.popupLabel}>Departed (UTC+3)</Text>
              <Text style={styles.popupVal}>{fmtUtc3(selected.actual_dep_utc) ?? '—'}</Text>
            </View>
            {selected.t ? (
              <View style={{ alignItems: 'center' }}>
                <Text style={styles.popupLabel}>Aircraft</Text>
                <Text style={styles.popupVal}>{selected.t}</Text>
              </View>
            ) : null}
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.popupLabel}>Status</Text>
              <Text style={[styles.popupVal,
                selected.actual_arr_utc ? { color: '#f97316' } : { color: '#4ade80' }
              ]}>
                {selected.actual_arr_utc ? 'Arrived' : 'En Route'}
              </Text>
            </View>
          </View>

          {selected.alt_baro != null && selected.alt_baro !== 'ground' && (
            <Text style={styles.popupExtra}>
              {typeof selected.alt_baro === 'number'
                ? `${Math.round(selected.alt_baro).toLocaleString()} ft`
                : 'Ground'
              }{selected.gs ? `  ·  ${Math.round(selected.gs)} kts` : ''}
            </Text>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  markerWrap: { alignItems: 'center' },
  labelWrap: { alignItems: 'center', marginTop: 2 },
  labelText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  arrivedText: {
    color: '#f97316',
    fontSize: 8,
    fontWeight: '700',
    fontFamily: 'monospace',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badge: {
    position: 'absolute', top: 56, right: 12,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5,
    borderWidth: 1, borderColor: '#374151',
  },
  badgeText: { color: '#d1d5db', fontSize: 11, fontWeight: '600' },
  popup: {
    position: 'absolute', bottom: 24, left: 16, right: 16,
    backgroundColor: '#111827',
    borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: '#374151',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5, shadowRadius: 10,
  },
  closeBtn: { position: 'absolute', top: 12, right: 12, padding: 4 },
  closeText: { color: '#6b7280', fontSize: 16 },
  flightNum: { color: '#fff', fontSize: 20, fontWeight: '700', fontFamily: 'monospace' },
  route: { color: '#9ca3af', fontSize: 13, marginTop: 2 },
  popupRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    marginTop: 12, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: '#1f2937',
  },
  popupLabel: { color: '#6b7280', fontSize: 11 },
  popupVal: { color: '#fff', fontSize: 15, fontWeight: '600', fontFamily: 'monospace', marginTop: 2 },
  popupExtra: { color: '#3b82f6', fontSize: 11, marginTop: 8 },
})

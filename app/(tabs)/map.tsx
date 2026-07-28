import { useRef, useState, useCallback } from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import WebView, { WebViewMessageEvent } from 'react-native-webview'
import { FlightCard } from '../../components/FlightCard'
import type { Flight } from '../../lib/types'
import { AIRLINE_NAMES } from '../../lib/constants'

const EMBED_URL = 'https://flighttracker-sy.vercel.app/embed'

type EmbedMsg =
  | { type: 'SELECT';  flight: EmbedFlight }
  | { type: 'DESELECT' }
  | { type: 'COUNT';   count: number }

interface EmbedFlight {
  callsign:       string
  iata_number:    string | null
  airline_iata:   string | null
  dep_iata:       string | null
  arr_iata:       string | null
  dep_time_utc:   string | null
  arr_time_utc:   string | null
  duration_min:   number | null
  status:         string
  actual_dep_utc:  string | null
  actual_arr_utc:  string | null
  revised_dep_utc: string | null
  revised_arr_utc: string | null
  aircraft_type:   string | null
  photoUrl:        string | null
}

function toFlight(ef: EmbedFlight): Flight {
  const isArr = ef.arr_iata === 'DAM' || ef.arr_iata === 'ALP'
  return {
    iata_number:    ef.iata_number    ?? ef.callsign,
    airline_name:   AIRLINE_NAMES[ef.airline_iata ?? ''] ?? ef.airline_iata ?? ef.callsign,
    airline_iata:   ef.airline_iata   ?? '',
    country_flag:   '',
    dep_iata:       ef.dep_iata       ?? '',
    arr_iata:       ef.arr_iata       ?? '',
    dep_time_utc:   ef.dep_time_utc   ?? '',
    arr_time_utc:   ef.arr_time_utc   ?? '',
    sched_dep_unix: null,
    duration_min:   ef.duration_min   ?? 0,
    status:         ef.status,
    actual_dep_utc:  ef.actual_dep_utc  ?? null,
    actual_arr_utc:  ef.actual_arr_utc  ?? null,
    revised_dep_utc: ef.revised_dep_utc ?? null,
    revised_arr_utc: ef.revised_arr_utc ?? null,
    aircraft_type:   ef.aircraft_type   ?? null,
    dep_terminal: null, dep_gate: null,
    arr_terminal: null, arr_gate: null, arr_baggage: null,
  }
}

export default function MapTab() {
  const webViewRef                          = useRef<WebView>(null)
  const [selected, setSelected]            = useState<Flight | null>(null)
  const [photoUrl, setPhotoUrl]            = useState<string | null>(null)
  const [count, setCount]                  = useState<number | null>(null)
  const [loading, setLoading]              = useState(true)

  const cardView = selected
    ? (selected.arr_iata === 'DAM' || selected.arr_iata === 'ALP' ? 'arr' : 'dep')
    : 'arr'

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    try {
      const msg: EmbedMsg = JSON.parse(e.nativeEvent.data)
      if (msg.type === 'SELECT')  { setSelected(toFlight(msg.flight)); setPhotoUrl(msg.flight.photoUrl) }
      if (msg.type === 'DESELECT') { setSelected(null); setPhotoUrl(null) }
      if (msg.type === 'COUNT')   setCount(msg.count)
    } catch {}
  }, [])

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ uri: EMBED_URL }}
        style={styles.webview}
        onMessage={onMessage}
        onLoadEnd={() => setLoading(false)}
        scrollEnabled={false}
        bounces={false}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
      />

      {/* In-air badge */}
      {count !== null && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{count} in Air</Text>
        </View>
      )}

      {/* Loading overlay */}
      {loading && (
        <View style={styles.loadingOverlay}>
          <Text style={styles.loadingText}>Loading map…</Text>
        </View>
      )}

      {/* Flight info card */}
      {selected && (
        <View style={styles.card}>
          <TouchableOpacity style={styles.closeBtn} onPress={() => {
            setSelected(null); setPhotoUrl(null)
            webViewRef.current?.injectJavaScript('window.__rnDeselect && window.__rnDeselect(); true;')
          }}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
          <FlightCard f={selected} view={cardView as 'arr' | 'dep'} hideBadge photoUrl={photoUrl} />
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#000' },
  webview:      { flex: 1 },
  badge: {
    position: 'absolute', top: 12, left: 12,
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 12, borderWidth: 1, borderColor: '#374151',
  },
  badgeText:    { color: '#9ca3af', fontSize: 12, fontWeight: '600' },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#111827',
    justifyContent: 'center', alignItems: 'center',
  },
  loadingText:  { color: '#6b7280', fontSize: 14 },
  card: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingHorizontal: 12, paddingBottom: 12, paddingTop: 4,
  },
  closeBtn: {
    position: 'absolute', top: 8, right: 20, zIndex: 10,
    backgroundColor: '#f3f4f6',
    borderRadius: 12, width: 24, height: 24,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: '#e5e7eb',
  },
  closeText:    { color: '#6b7280', fontSize: 14, lineHeight: 14 },
})

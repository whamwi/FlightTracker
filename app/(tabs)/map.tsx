import { useRef, useState, useCallback, useEffect } from 'react'
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Animated,
  ScrollView,
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import WebView, { WebViewMessageEvent } from 'react-native-webview'
import { FlightCard } from '../../components/FlightCard'
import type { Flight } from '../../lib/types'
import { AIRLINE_NAMES } from '../../lib/constants'

const EMBED_URL = 'https://flighttracker-sy.vercel.app/embed'

const C = {
  surface: '#FFFFFF',
  border:  '#D8D3BF',
  ink:     '#161616',
  sunken:  '#F7F5EC',
  muted:   '#8A8578',
}

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
  dep_delay_min:   number | null
  arr_delay_min:   number | null
  photoUrl:        string | null
}

// Only pass real aircraft photos through — filter out placeholder/fallback URLs
function realPhoto(url: string | null): string | null {
  if (!url) return null
  const lower = url.toLowerCase()
  if (
    lower.includes('placeholder') ||
    lower.includes('no-photo') ||
    lower.includes('no_photo') ||
    lower.includes('noimg') ||
    lower.includes('default') ||
    lower.includes('blank')
  ) return null
  return url
}

function toFlight(ef: EmbedFlight): Flight {
  // Prefer the IATA prefix from the flight number (e.g. "FYC" from "FYC728")
  // over airline_iata from the ADS-B feed which may be a codeshare or operating carrier
  const iataPrefix = (ef.iata_number ?? ef.callsign ?? '').replace(/[0-9].*/, '')
  const resolvedIata = (iataPrefix && AIRLINE_NAMES[iataPrefix]) ? iataPrefix : (ef.airline_iata ?? '')

  return {
    iata_number:    ef.iata_number    ?? ef.callsign,
    airline_name:   AIRLINE_NAMES[resolvedIata] ?? AIRLINE_NAMES[ef.airline_iata ?? ''] ?? ef.airline_iata ?? ef.callsign,
    airline_iata:   resolvedIata,
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
  const webViewRef                    = useRef<WebView>(null)
  const [selected, setSelected]       = useState<Flight | null>(null)
  const [photoUrl, setPhotoUrl]       = useState<string | null>(null)
  const [depDelay, setDepDelay]       = useState<number | null | undefined>(undefined)
  const [arrDelay, setArrDelay]       = useState<number | null | undefined>(undefined)
  const [loading, setLoading]         = useState(true)
  const slideAnim                     = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (selected) {
      slideAnim.setValue(0)
      Animated.spring(slideAnim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 11 }).start()
    }
  }, [selected])

  const translateY = slideAnim.interpolate({ inputRange: [0, 1], outputRange: [520, 0] })

  const dismiss = useCallback(() => {
    setSelected(null)
    setPhotoUrl(null)
    setDepDelay(undefined)
    setArrDelay(undefined)
    webViewRef.current?.injectJavaScript('window.__rnDeselect && window.__rnDeselect(); true;')
  }, [])

  const cardView = selected
    ? (selected.arr_iata === 'DAM' || selected.arr_iata === 'ALP' ? 'arr' : 'dep')
    : 'arr'

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    try {
      const msg: EmbedMsg = JSON.parse(e.nativeEvent.data)
      if (msg.type === 'SELECT') {
        setSelected(toFlight(msg.flight))
        setPhotoUrl(realPhoto(msg.flight.photoUrl))
        setDepDelay(msg.flight.dep_delay_min)
        setArrDelay(msg.flight.arr_delay_min)
      }
      if (msg.type === 'DESELECT') dismiss()
    } catch {}
  }, [dismiss])

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
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

      {loading && (
        <View style={styles.loadingOverlay}>
          <Text style={styles.loadingText}>Loading map…</Text>
        </View>
      )}

      {/* Bottom sheet — slides up over the tab bar via Modal */}
      <Modal
        transparent
        animationType="none"
        visible={!!selected}
        onRequestClose={dismiss}
        statusBarTranslucent
      >
        <View style={{ flex: 1 }} pointerEvents="box-none">
          {/* Transparent area above sheet — tap to dismiss */}
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={dismiss} />

          <Animated.View style={[styles.sheet, { transform: [{ translateY }] }]}>
            {/* Drag handle */}
            <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 8 }}>
              <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: C.border }} />
            </View>

            {/* Close button */}
            <TouchableOpacity style={styles.closeBtn} onPress={dismiss}>
              <Text style={styles.closeText}>✕</Text>
            </TouchableOpacity>

            <ScrollView
              scrollEnabled={false}
              contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 36 }}
            >
              {selected && (
                <FlightCard
                  f={selected}
                  view={cardView as 'arr' | 'dep'}
                  hideBadge
                  photoUrl={photoUrl}
                  depDelayMin={depDelay}
                  arrDelayMin={arrDelay}
                />
              )}
            </ScrollView>
          </Animated.View>
        </View>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  webview:   { flex: 1 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#111827',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: { color: '#6b7280', fontSize: 14 },
  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderTopWidth: 1,
    borderColor: C.border,
    shadowColor: C.ink,
    shadowOffset: { width: 0, height: -14 },
    shadowOpacity: 0.2,
    shadowRadius: 34,
    elevation: 16,
  },
  closeBtn: {
    position: 'absolute', top: 14, right: 18, zIndex: 10,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: C.sunken,
    borderWidth: 1, borderColor: C.border,
    justifyContent: 'center', alignItems: 'center',
  },
  closeText: { color: '#3D3A3B', fontSize: 14, lineHeight: 14 },
})

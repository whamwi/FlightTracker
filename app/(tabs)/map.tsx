import { useRef, useState, useCallback, useEffect } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, Modal, Animated, Image } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import WebView, { WebViewMessageEvent } from 'react-native-webview'
import type { Flight } from '../../lib/types'
import { AIRLINE_NAMES, city, airportFlag, airlineLogo, LOGO_WHITE_BG, fmtLocal, tzOffset, durationLabel } from '../../lib/constants'

const EMBED_URL = 'https://flighttracker-sy.vercel.app/embed'
const IN_FLIGHT = new Set(['En Route', 'Departed', 'Approaching'])

const AIRLINE_BRAND: Record<string, string> = {
  RB: '#0F3D6B', FYC: '#8B1A1A', TK: '#C70F3E', QR: '#5C0632',
  EY: '#B47E1A', RJ: '#002B7F', PC: '#D45000', ME: '#2D5A27',
  G9: '#CC0000', '3L': '#CC0000', XH: '#1A3A6B', FZ: '#CB3435',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcDelay(sched: string | null | undefined, actual: string | null | undefined): number | null {
  if (!sched || !actual) return null
  const actualMs = new Date(actual).getTime()
  if (isNaN(actualMs)) return null
  let schedMs = new Date(`${actual.slice(0, 10)}T${sched}:00Z`).getTime()
  if (schedMs - actualMs > 12 * 3_600_000) schedMs -= 86_400_000
  return Math.round((actualMs - schedMs) / 60_000)
}

function normalizePhoto(url: string | null | undefined): string | null {
  if (!url) return null
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('/'))  return `https://flighttracker-sy.vercel.app${url}`
  if (url.startsWith('http')) return url
  return null
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function LogoTile({ iata }: { iata: string }) {
  const [failed, setFailed] = useState(false)
  const initials = iata.slice(0, 2).toUpperCase()
  const bg = AIRLINE_BRAND[iata] ?? '#3D3A3B'

  if (failed) {
    return (
      <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: bg, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: '#FFF', fontSize: 12, fontWeight: '700', fontFamily: 'monospace' }}>{initials}</Text>
      </View>
    )
  }
  return (
    <View style={{ width: 38, height: 38, borderRadius: 10, overflow: 'hidden', backgroundColor: LOGO_WHITE_BG.has(iata) ? '#FFF' : '#F7F5EC', borderWidth: 1, borderColor: '#D8D3BF' }}>
      <Image source={{ uri: airlineLogo(iata) }} style={{ width: 38, height: 38 }} resizeMode="contain" onError={() => setFailed(true)} />
    </View>
  )
}

function MapStatusBadge({ status }: { status: string }) {
  const inFlight = IN_FLIGHT.has(status)
  const arrived  = status === 'Arrived'
  const bg  = inFlight ? '#428177' : arrived ? '#E6EFEC' : '#EFEDE3'
  const bdr = inFlight ? '#428177' : arrived ? '#B4CFC9' : '#D8D3BF'
  const dot = inFlight ? '#FFF'    : arrived ? '#054239' : '#8A8578'
  const txt = inFlight ? '#FFF'    : arrived ? '#002623' : '#3D3A3B'
  const lbl = inFlight ? 'En route': arrived ? 'Arrived' : status
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 8, paddingRight: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: bg, borderWidth: 1, borderColor: bdr, flexShrink: 0 }}>
      <View style={{ width: 6, height: 6, borderRadius: 99, backgroundColor: dot }} />
      <Text style={{ fontSize: 11, fontWeight: '600', color: txt }}>{lbl}</Text>
    </View>
  )
}

// Flag + city on top, IATA centered below
function RouteCol({ iata, flipFlag }: { iata: string; flipFlag?: boolean }) {
  return (
    <View style={{ width: 76, alignItems: 'center' }}>
      <View style={{ flexDirection: flipFlag ? 'row-reverse' : 'row', alignItems: 'center', gap: 4 }}>
        <Text style={{ fontSize: 13 }}>{airportFlag(iata)}</Text>
        <Text style={{ color: '#161616', fontWeight: '600', fontSize: 13 }} numberOfLines={1}>{city(iata)}</Text>
      </View>
      <Text style={{ color: '#8A8578', fontWeight: '400', fontSize: 11, fontFamily: 'monospace', letterSpacing: 0.5, marginTop: 2 }}>
        {iata}
      </Text>
    </View>
  )
}

const planeCircle = {
  width: 21, height: 21, borderRadius: 99,
  backgroundColor: '#FFF', borderWidth: 1.5, borderColor: '#428177',
  justifyContent: 'center' as const, alignItems: 'center' as const,
  shadowColor: '#428177', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 6, elevation: 3,
}
function ProgressBar({ depUtc, durationMin, altitude }: { depUtc: string; durationMin: number; altitude: number | null }) {
  const calc = () => Math.min(100, Math.max(0, ((Date.now() - new Date(depUtc).getTime()) / (durationMin * 60_000)) * 100))
  const [pct, setPct] = useState(calc)
  useEffect(() => {
    const t = setInterval(() => setPct(calc()), 30_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depUtc, durationMin])

  const remaining = Math.round((1 - pct / 100) * durationMin)
  const fill  = Math.max(0.5, pct)
  const empty = Math.max(0.5, 100 - pct)
  const label = (remaining > 0 ? `${durationLabel(remaining)} left` : 'Arriving') + (altitude ? ` · ${altitude.toLocaleString()} ft` : '')

  return (
    <View style={{ width: '100%', alignItems: 'center', gap: 6 }}>
      <Text style={{ color: '#8A8578', fontSize: 10.5, fontFamily: 'monospace' }}>{label}</Text>
      <View style={{ flexDirection: 'row', width: '100%', alignItems: 'center', height: 21 }}>
        <View style={{ flex: fill, height: 5, borderRadius: 99, backgroundColor: '#428177' }} />
        <View style={planeCircle}><Text style={{ color: '#428177', fontSize: 10 }}>✈</Text></View>
        <View style={{ flex: empty, height: 5, borderRadius: 99, backgroundColor: '#E0DCCB' }} />
      </View>
    </View>
  )
}

function ArrivalBar({ durationMin }: { durationMin: number }) {
  return (
    <View style={{ width: '100%', alignItems: 'center', gap: 6 }}>
      {durationMin > 0 && (
        <Text style={{ color: '#8A8578', fontSize: 10.5, fontFamily: 'monospace' }}>{durationLabel(durationMin)}</Text>
      )}
      <View style={{ flexDirection: 'row', width: '100%', alignItems: 'center', height: 21 }}>
        <View style={{ flex: 1, height: 5, borderRadius: 99, backgroundColor: '#9EBFB8' }} />
        <View style={planeCircle}><Text style={{ color: '#428177', fontSize: 10, transform: [{ rotate: '90deg' }] }}>✈</Text></View>
      </View>
    </View>
  )
}

// ─── Flight sheet ─────────────────────────────────────────────────────────────

function FlightSheet({ f, photoUrl, depDelayMin, arrDelayMin, altitude }: {
  f: Flight; photoUrl: string | null; altitude: number | null
  depDelayMin: number | null | undefined; arrDelayMin: number | null | undefined
}) {
  const isArr     = f.arr_iata === 'DAM' || f.arr_iata === 'ALP'
  const depOff    = isArr ? tzOffset(f.dep_iata) : 3
  const arrOff    = isArr ? 3 : tzOffset(f.arr_iata)
  const showProg  = IN_FLIGHT.has(f.status) && !!f.actual_dep_utc && f.duration_min > 0
  const isArrived = f.status === 'Arrived'

  const depTime = f.actual_dep_utc  ? fmtLocal(f.actual_dep_utc,  depOff)
                : f.revised_dep_utc ? fmtLocal(f.revised_dep_utc, depOff)
                :                     fmtLocal(f.dep_time_utc,    depOff)
  const arrTime = f.actual_arr_utc  ? fmtLocal(f.actual_arr_utc,  arrOff)
                : f.revised_arr_utc ? fmtLocal(f.revised_arr_utc, arrOff)
                :                     fmtLocal(f.arr_time_utc,    arrOff)

  const depDelay = depDelayMin !== undefined ? depDelayMin : calcDelay(f.dep_time_utc, f.actual_dep_utc ?? f.revised_dep_utc)
  const arrDelay = arrDelayMin !== undefined ? arrDelayMin : calcDelay(f.arr_time_utc, f.actual_arr_utc ?? f.revised_arr_utc)
  const depColor = f.actual_dep_utc ? '#002623' : f.revised_dep_utc ? '#6E5F3C' : '#161616'
  const arrColor = f.actual_arr_utc ? '#002623' : f.revised_arr_utc ? '#6E5F3C' : '#161616'
  const subtitle = [f.iata_number, f.aircraft_type].filter(Boolean).join(' · ')

  return (
    <View style={{ gap: 12 }}>
      {/* Header: logo + name/subtitle + badge (badge is now free — ✕ is in drag row) */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <LogoTile iata={f.airline_iata} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#161616', fontWeight: '600', fontSize: 15, lineHeight: 17 }} numberOfLines={1}>
            {f.airline_name}
          </Text>
          {!!subtitle && (
            <Text style={{ color: '#8A8578', fontSize: 11.5, fontFamily: 'monospace', letterSpacing: 0.7, marginTop: 3 }}>
              {subtitle}
            </Text>
          )}
        </View>
        <MapStatusBadge status={f.status} />
      </View>

      {/* Route: dep → bar → arr */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <RouteCol iata={f.dep_iata} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          {showProg ? (
            <ProgressBar depUtc={f.actual_dep_utc!} durationMin={f.duration_min} altitude={altitude} />
          ) : isArrived ? (
            <ArrivalBar durationMin={f.duration_min} />
          ) : (
            <View style={{ width: '100%', alignItems: 'center', gap: 6 }}>
              {f.duration_min > 0 && (
                <Text style={{ color: '#8A8578', fontSize: 10.5, fontFamily: 'monospace', textAlign: 'center' }}>
                  {durationLabel(f.duration_min)}{altitude ? ` · ${altitude.toLocaleString()} ft` : ''}
                </Text>
              )}
              <View style={{ width: '100%', height: 5, borderRadius: 99, backgroundColor: '#E0DCCB' }} />
            </View>
          )}
        </View>
        <RouteCol iata={f.arr_iata} flipFlag />
      </View>

      {/* Dep/Arr card */}
      <View style={{ borderRadius: 12, backgroundColor: '#F7F5EC', borderWidth: 1, borderColor: '#E0DCCB', paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: 9, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1.4, color: '#8A8578' }}>Departure</Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <Text style={{ color: depColor, fontSize: 19, fontWeight: '600', fontFamily: 'monospace' }}>{depTime}</Text>
            {depDelay !== null && Math.abs(depDelay ?? 0) >= 1 && (
              <Text style={{ fontSize: 10, fontWeight: '600', fontFamily: 'monospace', color: (depDelay ?? 0) > 0 ? '#6B1F2A' : '#002623', backgroundColor: (depDelay ?? 0) > 0 ? '#F1E6E7' : '#E6EFEC', paddingHorizontal: 5, paddingVertical: 3, borderRadius: 5 }}>
                {(depDelay ?? 0) > 0 ? `+${depDelay}m` : `${depDelay}m`}
              </Text>
            )}
          </View>
        </View>
        <View style={{ gap: 4, alignItems: 'flex-end' }}>
          <Text style={{ fontSize: 9, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1.4, color: '#8A8578' }}>Arrival</Text>
          <Text style={{ color: arrColor, fontSize: 19, fontWeight: '600', fontFamily: 'monospace' }}>{arrTime}</Text>
          {isArr && arrDelay !== null && Math.abs(arrDelay ?? 0) >= 1 && (
            <Text style={{ fontSize: 10, fontWeight: '600', fontFamily: 'monospace', color: (arrDelay ?? 0) > 0 ? '#6B1F2A' : '#002623', backgroundColor: (arrDelay ?? 0) > 0 ? '#F1E6E7' : '#E6EFEC', paddingHorizontal: 5, paddingVertical: 3, borderRadius: 5 }}>
              {(arrDelay ?? 0) > 0 ? `+${arrDelay}m` : `${arrDelay}m`}
            </Text>
          )}
        </View>
      </View>

      {/* Aircraft photo */}
      {!!photoUrl && (
        <View style={{ height: 130, borderRadius: 14, overflow: 'hidden' }}>
          <Image source={{ uri: photoUrl }} style={{ width: '100%', height: 130 }} resizeMode="cover" />
        </View>
      )}
    </View>
  )
}

// ─── Embed types ──────────────────────────────────────────────────────────────

type EmbedMsg =
  | { type: 'SELECT';  flight: EmbedFlight }
  | { type: 'DESELECT' }
  | { type: 'COUNT';   count: number }

interface EmbedFlight {
  callsign: string; iata_number: string | null; airline_iata: string | null
  dep_iata: string | null; arr_iata: string | null
  dep_time_utc: string | null; arr_time_utc: string | null
  duration_min: number | null; status: string
  actual_dep_utc: string | null; actual_arr_utc: string | null
  revised_dep_utc: string | null; revised_arr_utc: string | null
  aircraft_type: string | null; dep_delay_min: number | null; arr_delay_min: number | null
  // photo — try both naming conventions
  photoUrl?: string | null; photo_url?: string | null
  // altitude — try both naming conventions
  altitude?: number | null; altitude_ft?: number | null
}

function toFlight(ef: EmbedFlight): Flight {
  const prefix = (ef.iata_number ?? ef.callsign ?? '').replace(/[0-9].*/, '')
  const iata   = (prefix && AIRLINE_NAMES[prefix]) ? prefix : (ef.airline_iata ?? '')
  return {
    iata_number: ef.iata_number ?? ef.callsign, airline_iata: iata, country_flag: '',
    airline_name: AIRLINE_NAMES[iata] ?? AIRLINE_NAMES[ef.airline_iata ?? ''] ?? ef.airline_iata ?? ef.callsign,
    dep_iata: ef.dep_iata ?? '', arr_iata: ef.arr_iata ?? '',
    dep_time_utc: ef.dep_time_utc ?? '', arr_time_utc: ef.arr_time_utc ?? '',
    sched_dep_unix: null, duration_min: ef.duration_min ?? 0, status: ef.status,
    actual_dep_utc: ef.actual_dep_utc ?? null, actual_arr_utc: ef.actual_arr_utc ?? null,
    revised_dep_utc: ef.revised_dep_utc ?? null, revised_arr_utc: ef.revised_arr_utc ?? null,
    aircraft_type: ef.aircraft_type ?? null,
    dep_terminal: null, dep_gate: null, arr_terminal: null, arr_gate: null, arr_baggage: null,
  }
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function MapTab() {
  const webViewRef = useRef<any>(null)
  const [selected, setSelected] = useState<Flight | null>(null)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [altitude, setAltitude] = useState<number | null>(null)
  const [depDelay, setDepDelay] = useState<number | null | undefined>(undefined)
  const [arrDelay, setArrDelay] = useState<number | null | undefined>(undefined)
  const [loading,  setLoading]  = useState(true)
  const slideAnim = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (selected) {
      slideAnim.setValue(0)
      Animated.spring(slideAnim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 11 }).start()
    }
  }, [selected])

  const translateY = slideAnim.interpolate({ inputRange: [0, 1], outputRange: [600, 0] })

  const dismiss = useCallback(() => {
    setSelected(null); setPhotoUrl(null); setAltitude(null)
    setDepDelay(undefined); setArrDelay(undefined)
    webViewRef.current?.injectJavaScript('window.__rnDeselect && window.__rnDeselect(); true;')
  }, [])

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    try {
      const msg: EmbedMsg = JSON.parse(e.nativeEvent.data)
      if (msg.type === 'SELECT') {
        setSelected(toFlight(msg.flight))
        setPhotoUrl(normalizePhoto(msg.flight.photoUrl ?? msg.flight.photo_url))
        setAltitude(msg.flight.altitude ?? msg.flight.altitude_ft ?? null)
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

      <Modal transparent animationType="none" visible={!!selected} onRequestClose={dismiss} statusBarTranslucent>
        <View style={{ flex: 1, pointerEvents: 'box-none' } as any}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={dismiss} />
          <Animated.View style={[styles.sheet, { transform: [{ translateY }] }]}>

            {/* Tap the drag pill to dismiss */}
            <TouchableOpacity style={{ alignItems: 'center', paddingVertical: 10 }} activeOpacity={0.5} onPress={dismiss}>
              <View style={{ width: 38, height: 4, borderRadius: 99, backgroundColor: '#CFC9B2' }} />
            </TouchableOpacity>

            {selected && (
              <FlightSheet f={selected} photoUrl={photoUrl} altitude={altitude} depDelayMin={depDelay} arrDelayMin={arrDelay} />
            )}
          </Animated.View>
        </View>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#000' },
  webview:        { flex: 1 },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: '#111827', justifyContent: 'center', alignItems: 'center' },
  loadingText:    { color: '#6b7280', fontSize: 14 },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 26, borderTopRightRadius: 26,
    borderTopWidth: 1, borderColor: '#D8D3BF',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 30,
    shadowColor: '#161616', shadowOffset: { width: 0, height: -14 }, shadowOpacity: 0.2, shadowRadius: 34, elevation: 16,
  },
})

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  SafeAreaView,
  Modal,
  ScrollView,
  ActivityIndicator,
  Animated,
  Pressable,
  Image,
} from 'react-native'
import { API_BASE, city, airportFlag, airlineLogo, LOGO_WHITE_BG, durationLabel } from '../../lib/constants'
import type { Airport } from '../../lib/types'

// V2 Syria palette tokens
const C = {
  canvas:    '#EDEBE0',
  surface:   '#FFFFFF',
  sunken:    '#F7F5EC',
  track:     '#E4E1D2',
  border:    '#D8D3BF',
  ink:       '#161616',
  secondary: '#3D3A3B',
  muted:     '#8A8578',
  logoBg:    '#F7F5EC',
  damAccent: '#054239',
  alpAccent: '#6B1F2A',
  bubble:    '#F7F5EC',  // inactive day bubble bg
}

interface ScheduleRow {
  id: number
  dep_iata: string
  arr_iata: string
  dep_time: string
  arr_time: string
  duration_min: number
  days_of_week: string[]
  iata_number: string
  airline_name: string
  country_flag: string
  codeshare_iata: string | null
}

interface AirlineEntry { flag: string; name: string; prefix: string }

interface Destination {
  iata: string
  allDays: string[]
  airlines: AirlineEntry[]
  flights: ScheduleRow[]
  reverseFlights: ScheduleRow[]
  minDuration: number
}

const DOW_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const DOW_LABEL: Record<string, string> = {
  sun: 'S', mon: 'M', tue: 'T', wed: 'W', thu: 'T', fri: 'F', sat: 'S',
}

function sortDays(days: string[]): string[] {
  return [...days].sort(
    (a, b) =>
      DOW_ORDER.indexOf(a as typeof DOW_ORDER[number]) -
      DOW_ORDER.indexOf(b as typeof DOW_ORDER[number])
  )
}

function DayBubbles({ days, size = 'md', accent }: {
  days: string[]
  size?: 'sm' | 'md'
  accent: string
}) {
  const dim = size === 'md' ? 24 : 20
  const fontSize = size === 'md' ? 10 : 9
  const radius = size === 'md' ? 8 : 6
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {DOW_ORDER.map(d => {
        const active = days.includes(d)
        return (
          <View
            key={d}
            style={{
              width: dim, height: dim, borderRadius: radius,
              backgroundColor: active ? accent : C.bubble,
              borderWidth: active ? 0 : 1,
              borderColor: C.border,
              justifyContent: 'center', alignItems: 'center',
            }}
          >
            <Text style={{ color: active ? '#FFFFFF' : C.muted, fontSize, fontWeight: '600' }}>
              {DOW_LABEL[d]}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

function AirlineLogoStack({ airlines }: { airlines: AirlineEntry[] }) {
  const MAX = 3
  const shown = airlines.slice(0, MAX)
  const extra = airlines.length - MAX
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {shown.map(a => (
        <View
          key={a.prefix}
          style={{
            width: 24, height: 24, borderRadius: 7, overflow: 'hidden',
            backgroundColor: LOGO_WHITE_BG.has(a.prefix) ? C.surface : C.logoBg,
            justifyContent: 'center', alignItems: 'center',
            borderWidth: 1, borderColor: C.border,
          }}
        >
          <Image
            source={{ uri: airlineLogo(a.prefix) }}
            style={{ width: 24, height: 24 }}
            resizeMode="contain"
          />
        </View>
      ))}
      {extra > 0 && (
        <Text style={{ color: C.muted, fontSize: 10, fontWeight: '600', fontFamily: 'monospace' }}>+{extra}</Text>
      )}
    </View>
  )
}

function DestCard({ dest, onPress, accent }: {
  dest: Destination
  onPress: () => void
  accent: string
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        paddingHorizontal: 14,
        paddingVertical: 13,
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, marginRight: 8 }}>
          {airportFlag(dest.iata) ? (
            <Text style={{ fontSize: 16 }}>{airportFlag(dest.iata)}</Text>
          ) : null}
          <Text style={{ color: C.ink, fontWeight: '600', fontSize: 15 }} numberOfLines={1}>
            {city(dest.iata)}
          </Text>
          <Text style={{ color: C.muted, fontSize: 11.5, fontFamily: 'monospace' }}>
            {dest.iata}
          </Text>
        </View>
        <AirlineLogoStack airlines={dest.airlines} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <DayBubbles days={dest.allDays} size="md" accent={accent} />
        {dest.minDuration > 0 && (
          <Text style={{ color: C.muted, fontSize: 12, fontWeight: '600', fontFamily: 'monospace' }}>
            {durationLabel(dest.minDuration)}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  )
}

function FlightRow({ f, accent }: { f: ScheduleRow; accent: string }) {
  return (
    <View style={{
      borderRadius: 14,
      borderWidth: 1, borderColor: C.border,
      marginHorizontal: 14, marginBottom: 8,
      overflow: 'hidden',
      shadowColor: C.ink, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1,
    }}>
      {/* Airline + flight no + times */}
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, paddingBottom: 10 }}>
        <View style={{
          width: 32, height: 32, borderRadius: 9, overflow: 'hidden',
          backgroundColor: LOGO_WHITE_BG.has(f.iata_number.slice(0, 2)) ? C.surface : C.logoBg,
          justifyContent: 'center', alignItems: 'center', marginRight: 9,
          borderWidth: 1, borderColor: C.border,
        }}>
          <Image
            source={{ uri: airlineLogo(f.iata_number.slice(0, 2)) }}
            style={{ width: 32, height: 32 }}
            resizeMode="contain"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.ink, fontWeight: '600', fontSize: 13.5 }} numberOfLines={1}>{f.airline_name}</Text>
          <Text style={{ color: C.muted, fontSize: 11, fontFamily: 'monospace', marginTop: 1 }}>{f.iata_number}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: C.ink, fontWeight: '600', fontSize: 15, fontFamily: 'monospace' }}>{f.dep_time}</Text>
          <Text style={{ color: C.muted, fontSize: 11 }}>→</Text>
          <Text style={{ color: C.ink, fontWeight: '600', fontSize: 15, fontFamily: 'monospace' }}>{f.arr_time}</Text>
        </View>
      </View>
      {/* Day bubbles + aircraft type — sunken */}
      <View style={{ backgroundColor: C.sunken, borderTopWidth: 1, borderTopColor: C.border, paddingHorizontal: 12, paddingVertical: 9, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <DayBubbles days={f.days_of_week} size="sm" accent={accent} />
        {f.duration_min > 0 && (
          <Text style={{ color: C.muted, fontSize: 10.5, fontFamily: 'monospace' }}>
            {durationLabel(f.duration_min)}
          </Text>
        )}
      </View>
    </View>
  )
}

function BottomSheet({ dest, airport, onClose }: {
  dest: Destination | null
  airport: Airport
  onClose: () => void
}) {
  const [dir, setDir] = useState<'to' | 'from'>('to')
  const slideAnim = useRef(new Animated.Value(0)).current
  const accent = airport === 'ALP' ? C.alpAccent : C.damAccent

  useEffect(() => {
    if (dest) {
      setDir('to')
      Animated.spring(slideAnim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 11 }).start()
    } else {
      Animated.timing(slideAnim, { toValue: 0, duration: 220, useNativeDriver: true }).start()
    }
  }, [dest])

  const translateY = slideAnim.interpolate({ inputRange: [0, 1], outputRange: [600, 0] })
  const flights = dir === 'to' ? (dest?.flights ?? []) : (dest?.reverseFlights ?? [])
  const hasReverse = (dest?.reverseFlights.length ?? 0) > 0

  if (!dest) return null

  return (
    <Modal transparent animationType="none" visible={!!dest} onRequestClose={onClose}>
      <View style={{ flex: 1 }}>
        <Pressable
          onPress={onClose}
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(22,22,22,0.45)' }}
        />
        <Animated.View style={{
          position: 'absolute',
          bottom: 0, left: 0, right: 0,
          maxHeight: '82%',
          backgroundColor: C.surface,
          borderTopLeftRadius: 26,
          borderTopRightRadius: 26,
          borderTopWidth: 1,
          borderColor: C.border,
          transform: [{ translateY }],
          shadowColor: C.ink,
          shadowOffset: { width: 0, height: -14 },
          shadowOpacity: 0.25,
          shadowRadius: 34,
          elevation: 16,
        }}>
          {/* Drag handle */}
          <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 4 }}>
            <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: C.border }} />
          </View>

          {/* Header */}
          <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <View>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                  <Text style={{ fontSize: 22 }}>{airportFlag(dest.iata)}</Text>
                  <Text style={{ color: C.ink, fontWeight: '700', fontSize: 19 }}>{city(dest.iata)}</Text>
                  <Text style={{ color: C.muted, fontSize: 13, fontFamily: 'monospace' }}>{dest.iata}</Text>
                </View>
                <Text style={{ color: C.muted, fontSize: 11.5, marginTop: 3 }}>
                  {flights.length} {flights.length === 1 ? 'flight' : 'flights'}
                  {dest.minDuration > 0 ? ` · ${durationLabel(dest.minDuration)}` : ''}
                </Text>
              </View>
              <TouchableOpacity
                onPress={onClose}
                style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: C.sunken, justifyContent: 'center', alignItems: 'center' }}
              >
                <Text style={{ color: C.secondary, fontSize: 18, lineHeight: 22 }}>×</Text>
              </TouchableOpacity>
            </View>

            {hasReverse && (
              <View style={{ flexDirection: 'row', backgroundColor: C.track, borderRadius: 11, padding: 3, gap: 3 }}>
                {(['to', 'from'] as const).map(d => (
                  <TouchableOpacity
                    key={d}
                    onPress={() => setDir(d)}
                    style={{
                      flex: 1, paddingVertical: 7, borderRadius: 9, alignItems: 'center',
                      backgroundColor: dir === d ? C.ink : 'transparent',
                    }}
                  >
                    <Text style={{ color: dir === d ? '#FFFFFF' : C.muted, fontWeight: '700', fontSize: 12.5 }}>
                      {d === 'to' ? `To ${city(dest.iata)}` : `From ${city(dest.iata)}`}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 10 }}>
            {flights.map((f, i) => (
              <FlightRow key={`${f.id}-${i}`} f={f} accent={accent} />
            ))}
            {flights.length === 0 && (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <Text style={{ color: C.muted, fontSize: 14 }}>No scheduled flights</Text>
              </View>
            )}
            <View style={{ height: 32 }} />
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  )
}

export default function DestinationsScreen() {
  const [rows, setRows]       = useState<ScheduleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [airport, setAirport] = useState<Airport>('DAM')
  const [selected, setSelected] = useState<Destination | null>(null)

  useEffect(() => {
    fetch(`${API_BASE}/api/schedule`)
      .then(r => r.json())
      .then(d => { if (d.ok) setRows(d.rows) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const destinations = useMemo((): Destination[] => {
    const outbound = rows.filter(r => r.dep_iata === airport)
    const grouped = new Map<string, ScheduleRow[]>()
    for (const r of outbound) {
      if (!grouped.has(r.arr_iata)) grouped.set(r.arr_iata, [])
      grouped.get(r.arr_iata)!.push(r)
    }
    const reverseGrouped = new Map<string, ScheduleRow[]>()
    for (const r of rows.filter(r => r.arr_iata === airport)) {
      if (!reverseGrouped.has(r.dep_iata)) reverseGrouped.set(r.dep_iata, [])
      reverseGrouped.get(r.dep_iata)!.push(r)
    }
    return Array.from(grouped.entries())
      .map(([iata, flights]) => {
        const allDays = sortDays([...new Set(flights.flatMap(f => f.days_of_week))])
        const seen = new Set<string>()
        const airlines: AirlineEntry[] = []
        for (const f of flights) {
          const prefix = f.iata_number.slice(0, 2)
          if (!seen.has(prefix)) {
            seen.add(prefix)
            airlines.push({ flag: f.country_flag, name: f.airline_name, prefix })
          }
        }
        const durations = flights.map(f => f.duration_min).filter(Boolean)
        const minDuration = durations.length ? Math.min(...durations) : 0
        const sorted = [...flights].sort((a, b) => a.dep_time.localeCompare(b.dep_time))
        const reverseFlights = [...(reverseGrouped.get(iata) ?? [])].sort((a, b) => a.dep_time.localeCompare(b.dep_time))
        return { iata, allDays, airlines, flights: sorted, reverseFlights, minDuration }
      })
      .sort((a, b) => city(a.iata).localeCompare(city(b.iata)))
  }, [rows, airport])

  const handleClose = useCallback(() => setSelected(null), [])
  const accent = airport === 'ALP' ? C.alpAccent : C.damAccent
  const airportName = airport === 'DAM' ? 'Damascus' : 'Aleppo'

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.canvas }}>
      {/* Header */}
      <View style={{
        backgroundColor: C.surface,
        paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10,
        borderBottomWidth: 1, borderBottomColor: C.border,
        gap: 10,
        shadowColor: C.ink, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.08, shadowRadius: 14, elevation: 4,
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: C.ink, fontWeight: '700', fontSize: 20, letterSpacing: -0.15 }}>Destinations</Text>
          {!loading && destinations.length > 0 && (
            <Text style={{ color: C.muted, fontSize: 11.5 }}>{destinations.length} cities</Text>
          )}
        </View>
        <View style={{ flexDirection: 'row', backgroundColor: C.track, borderRadius: 10, padding: 3, gap: 3 }}>
          {(['DAM', 'ALP'] as Airport[]).map(ap => {
            const active = airport === ap
            const apAccent = ap === 'ALP' ? C.alpAccent : C.damAccent
            return (
              <TouchableOpacity
                key={ap}
                onPress={() => setAirport(ap)}
                style={{
                  flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center',
                  backgroundColor: active ? apAccent : 'transparent',
                }}
              >
                <Text style={{ color: active ? '#FFFFFF' : C.muted, fontWeight: active ? '700' : '600', fontSize: 13 }}>
                  {ap === 'DAM' ? 'Damascus' : 'Aleppo'}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>
      </View>

      {!loading && (
        <Text style={{ color: C.muted, fontSize: 11.5, paddingHorizontal: 14, paddingVertical: 8 }}>
          {destinations.length === 0
            ? 'No routes found'
            : `${destinations.length} destination${destinations.length === 1 ? '' : 's'} from ${airportName}`}
        </Text>
      )}

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 }}>
          <ActivityIndicator size="large" color={accent} />
          <Text style={{ color: C.muted, fontSize: 14 }}>Loading routes…</Text>
        </View>
      ) : destinations.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8, paddingHorizontal: 24 }}>
          <Text style={{ fontSize: 40 }}>✈</Text>
          <Text style={{ color: C.secondary, fontWeight: '600', fontSize: 15 }}>No routes found</Text>
          <Text style={{ color: C.muted, fontSize: 13, textAlign: 'center' }}>Try switching airport</Text>
        </View>
      ) : (
        <FlatList
          data={destinations}
          keyExtractor={d => d.iata}
          renderItem={({ item }) => (
            <DestCard dest={item} onPress={() => setSelected(item)} accent={accent} />
          )}
          contentContainerStyle={{ paddingBottom: 24 }}
          style={{ backgroundColor: C.surface }}
        />
      )}

      <BottomSheet dest={selected} airport={airport} onClose={handleClose} />
    </SafeAreaView>
  )
}

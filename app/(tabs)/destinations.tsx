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

function DayBubbles({ days, size = 'md', color = '#16a34a' }: {
  days: string[]
  size?: 'sm' | 'md'
  color?: string
}) {
  const dim = size === 'md' ? 26 : 22
  const fontSize = size === 'md' ? 10 : 9
  return (
    <View style={{ flexDirection: 'row', gap: 3 }}>
      {DOW_ORDER.map(d => {
        const active = days.includes(d)
        return (
          <View
            key={d}
            style={{
              width: dim, height: dim, borderRadius: dim / 2,
              backgroundColor: active ? color : '#e5e7eb',
              justifyContent: 'center', alignItems: 'center',
            }}
          >
            <Text style={{ color: active ? '#fff' : '#9ca3af', fontSize, fontWeight: '700' }}>
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
            width: 28, height: 28, borderRadius: 8, overflow: 'hidden',
            backgroundColor: LOGO_WHITE_BG.has(a.prefix) ? '#f3f4f6' : '#f9fafb',
            justifyContent: 'center', alignItems: 'center',
            borderWidth: 0.5, borderColor: '#e5e7eb',
          }}
        >
          <Image
            source={{ uri: airlineLogo(a.prefix) }}
            style={{ width: 28, height: 28, borderRadius: 8 }}
            resizeMode="contain"
          />
        </View>
      ))}
      {extra > 0 && (
        <Text style={{ color: '#9ca3af', fontSize: 11, fontWeight: '600' }}>+{extra}</Text>
      )}
    </View>
  )
}

function DestCard({ dest, onPress, color }: {
  dest: Destination
  onPress: () => void
  color: string
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        borderBottomWidth: 0.5,
        borderBottomColor: '#e5e7eb',
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, marginRight: 8 }}>
          {airportFlag(dest.iata) ? (
            <Text style={{ fontSize: 18 }}>{airportFlag(dest.iata)}</Text>
          ) : null}
          <Text style={{ color: '#111827', fontWeight: '600', fontSize: 15 }} numberOfLines={1}>
            {city(dest.iata)}
          </Text>
          <Text style={{ color: '#9ca3af', fontSize: 13, fontFamily: 'monospace' }}>
            {dest.iata}
          </Text>
        </View>
        <AirlineLogoStack airlines={dest.airlines} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <DayBubbles days={dest.allDays} size="md" color={color} />
        {dest.minDuration > 0 && (
          <Text style={{ color: '#9ca3af', fontSize: 13, fontWeight: '500' }}>
            {durationLabel(dest.minDuration)}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  )
}

function FlightRow({ f, color }: { f: ScheduleRow; color: string }) {
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: '#e5e7eb' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
        <View style={{
          width: 32, height: 32, borderRadius: 10, overflow: 'hidden',
          backgroundColor: LOGO_WHITE_BG.has(f.iata_number.slice(0, 2)) ? '#f3f4f6' : '#f9fafb',
          justifyContent: 'center', alignItems: 'center', marginRight: 8,
          borderWidth: 0.5, borderColor: '#e5e7eb',
        }}>
          <Image
            source={{ uri: airlineLogo(f.iata_number.slice(0, 2)) }}
            style={{ width: 32, height: 32, borderRadius: 10 }}
            resizeMode="contain"
          />
        </View>
        <Text style={{ color: '#111827', fontWeight: '600', fontSize: 13, flex: 1 }} numberOfLines={1}>
          {f.airline_name}
        </Text>
        <Text style={{ color: '#9ca3af', fontSize: 12, fontFamily: 'monospace' }}>
          {f.iata_number}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
        <Text style={{ color: '#111827', fontWeight: '600', fontSize: 18, fontFamily: 'monospace' }}>
          {f.dep_time}
        </Text>
        <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', width: '100%' }}>
            <View style={{ flex: 1, height: 1, backgroundColor: '#d1d5db' }} />
            <Text style={{ color: '#9ca3af', fontSize: 12, marginHorizontal: 4 }}>✈</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: '#d1d5db' }} />
          </View>
          {f.duration_min > 0 && (
            <Text style={{ color: '#9ca3af', fontSize: 11, fontWeight: '500' }}>
              {durationLabel(f.duration_min)}
            </Text>
          )}
        </View>
        <Text style={{ color: '#111827', fontWeight: '600', fontSize: 18, fontFamily: 'monospace' }}>
          {f.arr_time}
        </Text>
      </View>
      <DayBubbles days={f.days_of_week} size="sm" color={color} />
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
  const color = airport === 'ALP' ? '#f97316' : '#16a34a'

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
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.35)' }}
        />
        <Animated.View style={{
          position: 'absolute',
          bottom: 0, left: 0, right: 0,
          maxHeight: '82%',
          backgroundColor: '#ffffff',
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          borderTopWidth: 0.5,
          borderColor: '#e5e7eb',
          transform: [{ translateY }],
        }}>
          <View style={{ alignItems: 'center', paddingTop: 12, paddingBottom: 4 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: '#d1d5db' }} />
          </View>

          <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, borderBottomWidth: 0.5, borderBottomColor: '#e5e7eb' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <View>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                  <Text style={{ color: '#111827', fontWeight: '700', fontSize: 18 }}>
                    {city(dest.iata)}
                  </Text>
                  <Text style={{ color: '#9ca3af', fontSize: 15, fontFamily: 'monospace' }}>
                    {dest.iata}
                  </Text>
                </View>
                <Text style={{ color: '#9ca3af', fontSize: 12, marginTop: 2 }}>
                  {flights.length} {flights.length === 1 ? 'flight' : 'flights'}
                  {dest.minDuration > 0 ? ` · ${durationLabel(dest.minDuration)}` : ''}
                </Text>
              </View>
              <TouchableOpacity
                onPress={onClose}
                style={{
                  width: 32, height: 32, borderRadius: 16,
                  backgroundColor: '#f3f4f6',
                  justifyContent: 'center', alignItems: 'center',
                }}
              >
                <Text style={{ color: '#6b7280', fontSize: 18, lineHeight: 22 }}>×</Text>
              </TouchableOpacity>
            </View>

            {hasReverse && (
              <View style={{
                flexDirection: 'row', backgroundColor: '#f3f4f6',
                borderRadius: 10, padding: 3, gap: 3,
              }}>
                {(['to', 'from'] as const).map(d => (
                  <TouchableOpacity
                    key={d}
                    onPress={() => setDir(d)}
                    style={{
                      flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center',
                      backgroundColor: dir === d ? '#111827' : 'transparent',
                    }}
                  >
                    <Text style={{
                      color: dir === d ? '#ffffff' : '#6b7280',
                      fontWeight: '600', fontSize: 13,
                    }}>
                      {d === 'to' ? `To ${city(dest.iata)}` : `From ${city(dest.iata)}`}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

          <ScrollView style={{ flex: 1 }}>
            {flights.map((f, i) => (
              <FlightRow key={`${f.id}-${i}`} f={f} color={color} />
            ))}
            {flights.length === 0 && (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <Text style={{ color: '#9ca3af', fontSize: 14 }}>No scheduled flights</Text>
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
  const color = airport === 'ALP' ? '#f97316' : '#16a34a'
  const airportLabel = airport === 'DAM' ? 'Damascus · DAM' : 'Aleppo · ALP'

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#ffffff' }}>
      <View style={{
        paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10,
        borderBottomWidth: 0.5, borderBottomColor: '#e5e7eb', gap: 10,
      }}>
        <Text style={{ color: '#111827', fontWeight: '700', fontSize: 16, textAlign: 'center' }}>
          {airportLabel}
        </Text>
        <View style={{ flexDirection: 'row', backgroundColor: '#f3f4f6', borderRadius: 10, padding: 3, gap: 3 }}>
          {(['DAM', 'ALP'] as Airport[]).map(ap => (
            <TouchableOpacity
              key={ap}
              onPress={() => setAirport(ap)}
              style={{
                flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center',
                backgroundColor: airport === ap ? '#111827' : 'transparent',
              }}
            >
              <Text style={{ color: airport === ap ? '#ffffff' : '#6b7280', fontWeight: '600', fontSize: 14 }}>
                {ap === 'DAM' ? 'Damascus' : 'Aleppo'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {!loading && (
        <Text style={{ color: '#9ca3af', fontSize: 12, paddingHorizontal: 16, paddingVertical: 8 }}>
          {destinations.length === 0
            ? 'No routes found'
            : `${destinations.length} destination${destinations.length === 1 ? '' : 's'} from ${airport}`}
        </Text>
      )}

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 }}>
          <ActivityIndicator size="large" color="#111827" />
          <Text style={{ color: '#9ca3af', fontSize: 14 }}>Loading routes…</Text>
        </View>
      ) : destinations.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8, paddingHorizontal: 24 }}>
          <Text style={{ fontSize: 40 }}>✈</Text>
          <Text style={{ color: '#6b7280', fontWeight: '600', fontSize: 15 }}>No routes found</Text>
          <Text style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center' }}>Try switching airport</Text>
        </View>
      ) : (
        <FlatList
          data={destinations}
          keyExtractor={d => d.iata}
          renderItem={({ item }) => (
            <DestCard dest={item} onPress={() => setSelected(item)} color={color} />
          )}
          contentContainerStyle={{ paddingBottom: 24 }}
        />
      )}

      <BottomSheet dest={selected} airport={airport} onClose={handleClose} />
    </SafeAreaView>
  )
}

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
  Linking,
  RefreshControl,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
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
  website_url: string | null
  facebook_url: string | null
  instagram_url: string | null
}

interface Airline {
  prefix: string
  name: string
  flag: string
  allDays: string[]
  routes: ScheduleRow[]
  website_url: string | null
  facebook_url: string | null
  instagram_url: string | null
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

function AirlineCard({ airline, onPress, color }: {
  airline: Airline
  onPress: () => void
  color: string
}) {
  const destFlags = [...new Set(
    airline.routes
      .map(r => r.arr_iata === 'DAM' || r.arr_iata === 'ALP' ? r.dep_iata : r.arr_iata)
      .map(iata => airportFlag(iata))
      .filter(Boolean)
  )]

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
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 12 }}>
        <View style={{
          width: 44, height: 44, borderRadius: 14, overflow: 'hidden',
          backgroundColor: LOGO_WHITE_BG.has(airline.prefix) ? '#f3f4f6' : '#f9fafb',
          justifyContent: 'center', alignItems: 'center',
          borderWidth: 0.5, borderColor: '#e5e7eb',
        }}>
          <Image
            source={{ uri: airlineLogo(airline.prefix) }}
            style={{ width: 44, height: 44, borderRadius: 14 }}
            resizeMode="contain"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#111827', fontWeight: '600', fontSize: 15 }} numberOfLines={1}>
            {airline.name}
          </Text>
          <Text style={{ color: '#6b7280', fontSize: 12, marginTop: 1 }}>
            {airline.prefix} · {airline.routes.length} {airline.routes.length === 1 ? 'route' : 'routes'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 2 }}>
          {destFlags.slice(0, 3).map((flag, i) => (
            <Text key={i} style={{ fontSize: 30 }}>{flag}</Text>
          ))}
          {destFlags.length > 3 && (
            <Text style={{ color: '#9ca3af', fontSize: 11, fontWeight: '600', alignSelf: 'center' }}>
              +{destFlags.length - 3}
            </Text>
          )}
        </View>
      </View>
      <DayBubbles days={airline.allDays} size="md" color={color} />
    </TouchableOpacity>
  )
}

function RouteRow({ f, color }: { f: ScheduleRow; color: string }) {
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: '#e5e7eb' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
        <Text style={{ color: '#9ca3af', fontSize: 12, fontFamily: 'monospace', flex: 1 }}>
          {f.iata_number}
        </Text>
        {f.duration_min > 0 && (
          <Text style={{ color: '#9ca3af', fontSize: 12 }}>{durationLabel(f.duration_min)}</Text>
        )}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
        <View style={{ alignItems: 'flex-start', minWidth: 80 }}>
          <Text style={{ color: '#111827', fontWeight: '600', fontSize: 18, fontFamily: 'monospace' }}>
            {f.dep_time}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
            <Text style={{ fontSize: 13 }}>{airportFlag(f.dep_iata)}</Text>
            <Text style={{ color: '#6b7280', fontSize: 12 }}>{city(f.dep_iata)}</Text>
          </View>
          <Text style={{ color: '#9ca3af', fontSize: 11, fontFamily: 'monospace', marginTop: 1 }}>
            {f.dep_iata}
          </Text>
        </View>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: '#d1d5db' }} />
          <Text style={{ color: '#9ca3af', fontSize: 12, marginHorizontal: 4 }}>✈</Text>
          <View style={{ flex: 1, height: 1, backgroundColor: '#d1d5db' }} />
        </View>
        <View style={{ alignItems: 'flex-end', minWidth: 80 }}>
          <Text style={{ color: '#111827', fontWeight: '600', fontSize: 18, fontFamily: 'monospace' }}>
            {f.arr_time}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
            <Text style={{ color: '#6b7280', fontSize: 12 }}>{city(f.arr_iata)}</Text>
            <Text style={{ fontSize: 13 }}>{airportFlag(f.arr_iata)}</Text>
          </View>
          <Text style={{ color: '#9ca3af', fontSize: 11, fontFamily: 'monospace', marginTop: 1 }}>
            {f.arr_iata}
          </Text>
        </View>
      </View>
      <DayBubbles days={f.days_of_week} size="sm" color={color} />
    </View>
  )
}

function BottomSheet({ airline, airport, onClose }: {
  airline: Airline | null
  airport: Airport
  onClose: () => void
}) {
  const [dir, setDir] = useState<'out' | 'in'>('out')
  const slideAnim = useRef(new Animated.Value(0)).current
  const color = airport === 'ALP' ? '#f97316' : '#16a34a'

  useEffect(() => { if (airline) setDir('out') }, [airline])

  useEffect(() => {
    if (airline) {
      Animated.spring(slideAnim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 11 }).start()
    } else {
      Animated.timing(slideAnim, { toValue: 0, duration: 220, useNativeDriver: true }).start()
    }
  }, [airline])

  const translateY = slideAnim.interpolate({ inputRange: [0, 1], outputRange: [600, 0] })

  if (!airline) return null

  return (
    <Modal transparent animationType="none" visible={!!airline} onRequestClose={onClose}>
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

          <View style={{
            paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14,
            borderBottomWidth: 0.5, borderBottomColor: '#e5e7eb',
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{
                width: 48, height: 48, borderRadius: 14, overflow: 'hidden',
                backgroundColor: LOGO_WHITE_BG.has(airline.prefix) ? '#f3f4f6' : '#f9fafb',
                justifyContent: 'center', alignItems: 'center',
                borderWidth: 0.5, borderColor: '#e5e7eb',
              }}>
                <Image
                  source={{ uri: airlineLogo(airline.prefix) }}
                  style={{ width: 48, height: 48, borderRadius: 14 }}
                  resizeMode="contain"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#111827', fontWeight: '700', fontSize: 17 }} numberOfLines={1}>
                  {airline.name}
                </Text>
                <Text style={{ color: '#6b7280', fontSize: 12, marginTop: 2 }}>
                  {airline.routes.length} {airline.routes.length === 1 ? 'route' : 'routes'} · {airline.prefix}
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

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
              {([
                { icon: 'globe-outline',  label: 'Website',   url: airline.website_url },
                { icon: 'logo-facebook',  label: 'Facebook',  url: airline.facebook_url },
                { icon: 'logo-instagram', label: 'Instagram', url: airline.instagram_url },
              ] as const).map(({ icon, label, url }) => {
                const active = !!url
                return (
                  <TouchableOpacity
                    key={icon}
                    onPress={() => url && Linking.openURL(url)}
                    disabled={!active}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 6,
                      backgroundColor: '#f3f4f6', borderRadius: 8,
                      paddingHorizontal: 12, paddingVertical: 7,
                      opacity: active ? 1 : 0.4,
                    }}
                  >
                    <Ionicons name={icon} size={16} color={active ? '#374151' : '#9ca3af'} />
                    <Text style={{ color: active ? '#374151' : '#9ca3af', fontSize: 13, fontWeight: '500' }}>{label}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>

          {(() => {
            const outRoutes = airline.routes.filter(r => r.dep_iata === airport)
            const inRoutes  = airline.routes.filter(r => r.arr_iata === airport)
            const hasIn = inRoutes.length > 0
            const hasOut = outRoutes.length > 0
            const routes = dir === 'out' ? outRoutes : inRoutes
            const airportCity = airport === 'DAM' ? 'Damascus' : 'Aleppo'
            return (
              <>
                {(hasOut && hasIn) && (
                  <View style={{
                    flexDirection: 'row', backgroundColor: '#f3f4f6',
                    borderRadius: 10, padding: 3, gap: 3,
                    marginHorizontal: 16, marginVertical: 10,
                  }}>
                    {(['out', 'in'] as const).map(d => (
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
                          {d === 'out' ? `From ${airportCity}` : `To ${airportCity}`}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
                <ScrollView style={{ flex: 1 }}>
                  {routes.map((f, i) => (
                    <RouteRow key={`${f.id}-${i}`} f={f} color={color} />
                  ))}
                  <View style={{ height: 32 }} />
                </ScrollView>
              </>
            )
          })()}
        </Animated.View>
      </View>
    </Modal>
  )
}

export default function AirlinesScreen() {
  const [rows, setRows]         = useState<ScheduleRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [airport, setAirport]   = useState<Airport>('DAM')
  const [selected, setSelected] = useState<Airline | null>(null)

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const r = await fetch(`${API_BASE}/api/schedule`)
      const d = await r.json()
      if (d.ok) setRows(d.rows)
    } catch {}
    finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const airlines = useMemo((): Airline[] => {
    const relevant = rows.filter(r => r.dep_iata === airport || r.arr_iata === airport)
    const grouped = new Map<string, ScheduleRow[]>()
    for (const r of relevant) {
      const prefix = r.iata_number.slice(0, 2)
      if (!grouped.has(prefix)) grouped.set(prefix, [])
      grouped.get(prefix)!.push(r)
    }
    return Array.from(grouped.entries())
      .map(([prefix, routes]) => {
        const allDays = sortDays([...new Set(routes.flatMap(r => r.days_of_week))])
        const sorted = [...routes].sort((a, b) => a.dep_time.localeCompare(b.dep_time))
        const first = routes[0]
        return {
          prefix,
          name: first.airline_name,
          flag: first.country_flag,
          allDays,
          routes: sorted,
          website_url:   first.website_url ?? null,
          facebook_url:  first.facebook_url ?? null,
          instagram_url: first.instagram_url ?? null,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
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
          {airlines.length === 0
            ? 'No airlines found'
            : `${airlines.length} airline${airlines.length === 1 ? '' : 's'} flying to ${airport}`}
        </Text>
      )}

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 }}>
          <ActivityIndicator size="large" color="#111827" />
          <Text style={{ color: '#9ca3af', fontSize: 14 }}>Loading airlines…</Text>
        </View>
      ) : airlines.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8, paddingHorizontal: 24 }}>
          <Text style={{ fontSize: 40 }}>🛫</Text>
          <Text style={{ color: '#6b7280', fontWeight: '600', fontSize: 15 }}>No airlines found</Text>
          <Text style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center' }}>Try switching airport</Text>
        </View>
      ) : (
        <FlatList
          data={airlines}
          keyExtractor={a => a.prefix}
          renderItem={({ item }) => (
            <AirlineCard airline={item} onPress={() => setSelected(item)} color={color} />
          )}
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#111827" />
          }
        />
      )}

      <BottomSheet airline={selected} airport={airport} onClose={handleClose} />
    </SafeAreaView>
  )
}

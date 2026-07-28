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
  bubble:    '#F7F5EC',
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

function DayBubbles({ days, size = 'md', accent }: {
  days: string[]
  size?: 'sm' | 'md'
  accent: string
}) {
  const dim = size === 'md' ? 22 : 20
  const fontSize = size === 'md' ? 10 : 9
  const radius = size === 'md' ? 7 : 6
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

function AirlineCard({ airline, onPress, accent }: {
  airline: Airline
  onPress: () => void
  accent: string
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
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        paddingHorizontal: 14,
        paddingVertical: 14,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 12 }}>
        <View style={{
          width: 44, height: 44, borderRadius: 12, overflow: 'hidden',
          backgroundColor: LOGO_WHITE_BG.has(airline.prefix) ? C.surface : C.logoBg,
          justifyContent: 'center', alignItems: 'center',
          borderWidth: 1, borderColor: C.border,
        }}>
          <Image source={{ uri: airlineLogo(airline.prefix) }} style={{ width: 44, height: 44 }} resizeMode="contain" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.ink, fontWeight: '600', fontSize: 15 }} numberOfLines={1}>{airline.name}</Text>
          <Text style={{ color: C.muted, fontSize: 11, fontFamily: 'monospace', marginTop: 1 }}>
            {airline.prefix} · {airline.routes.length} {airline.routes.length === 1 ? 'route' : 'routes'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 2 }}>
          {destFlags.slice(0, 3).map((flag, i) => (
            <Text key={i} style={{ fontSize: 20 }}>{flag}</Text>
          ))}
          {destFlags.length > 3 && (
            <Text style={{ color: C.muted, fontSize: 11, fontWeight: '600', alignSelf: 'center' }}>
              +{destFlags.length - 3}
            </Text>
          )}
        </View>
      </View>
      <DayBubbles days={airline.allDays} size="md" accent={accent} />
    </TouchableOpacity>
  )
}

function RouteRow({ f, accent }: { f: ScheduleRow; accent: string }) {
  return (
    <View style={{
      borderRadius: 14,
      borderWidth: 1, borderColor: C.border,
      marginHorizontal: 14, marginBottom: 8,
      overflow: 'hidden',
      shadowColor: C.ink, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1,
    }}>
      {/* Route times */}
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, paddingBottom: 10 }}>
        <View style={{ alignItems: 'flex-start', minWidth: 80 }}>
          <Text style={{ color: C.ink, fontWeight: '600', fontSize: 18, fontFamily: 'monospace' }}>{f.dep_time}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 }}>
            <Text style={{ fontSize: 13 }}>{airportFlag(f.dep_iata)}</Text>
            <Text style={{ color: C.secondary, fontSize: 12 }}>{city(f.dep_iata)}</Text>
          </View>
          <Text style={{ color: C.muted, fontSize: 11, fontFamily: 'monospace', marginTop: 1 }}>{f.dep_iata}</Text>
        </View>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: C.border }} />
          <Text style={{ color: C.muted, fontSize: 14, paddingHorizontal: 6 }}>✈</Text>
          <View style={{ flex: 1, height: 1, backgroundColor: C.border }} />
        </View>
        <View style={{ alignItems: 'flex-end', minWidth: 80 }}>
          <Text style={{ color: C.ink, fontWeight: '600', fontSize: 18, fontFamily: 'monospace' }}>{f.arr_time}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 }}>
            <Text style={{ color: C.secondary, fontSize: 12 }}>{city(f.arr_iata)}</Text>
            <Text style={{ fontSize: 13 }}>{airportFlag(f.arr_iata)}</Text>
          </View>
          <Text style={{ color: C.muted, fontSize: 11, fontFamily: 'monospace', marginTop: 1 }}>{f.arr_iata}</Text>
        </View>
      </View>
      {/* Day bubbles + flight info — sunken */}
      <View style={{ backgroundColor: C.sunken, borderTopWidth: 1, borderTopColor: C.border, paddingHorizontal: 12, paddingVertical: 9, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <DayBubbles days={f.days_of_week} size="sm" accent={accent} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: C.muted, fontSize: 11, fontFamily: 'monospace' }}>{f.iata_number}</Text>
          {f.duration_min > 0 && (
            <Text style={{ color: C.muted, fontSize: 10.5, fontFamily: 'monospace' }}>{durationLabel(f.duration_min)}</Text>
          )}
        </View>
      </View>
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
  const accent = airport === 'ALP' ? C.alpAccent : C.damAccent

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

          {/* Airline header */}
          <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <View style={{
                width: 48, height: 48, borderRadius: 13, overflow: 'hidden',
                backgroundColor: LOGO_WHITE_BG.has(airline.prefix) ? C.surface : C.logoBg,
                justifyContent: 'center', alignItems: 'center',
                borderWidth: 1, borderColor: C.border,
              }}>
                <Image source={{ uri: airlineLogo(airline.prefix) }} style={{ width: 48, height: 48 }} resizeMode="contain" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.ink, fontWeight: '700', fontSize: 19 }} numberOfLines={1}>{airline.name}</Text>
                <Text style={{ color: C.muted, fontSize: 12, fontFamily: 'monospace', marginTop: 2 }}>
                  {airline.prefix} · {airline.routes.length} {airline.routes.length === 1 ? 'route' : 'routes'}
                </Text>
              </View>
              <TouchableOpacity
                onPress={onClose}
                style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: C.sunken, justifyContent: 'center', alignItems: 'center' }}
              >
                <Text style={{ color: C.secondary, fontSize: 18, lineHeight: 22 }}>×</Text>
              </TouchableOpacity>
            </View>

            {/* Link buttons */}
            <View style={{ flexDirection: 'row', gap: 8 }}>
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
                      backgroundColor: C.sunken, borderRadius: 11,
                      borderWidth: 1, borderColor: C.border,
                      paddingHorizontal: 12, paddingVertical: 7,
                      opacity: active ? 1 : 0.4,
                    }}
                  >
                    <Ionicons name={icon} size={15} color={active ? C.secondary : C.muted} />
                    <Text style={{ color: active ? C.secondary : C.muted, fontSize: 12, fontWeight: '600' }}>{label}</Text>
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
                    flexDirection: 'row', backgroundColor: C.track,
                    borderRadius: 11, padding: 3, gap: 3,
                    marginHorizontal: 16, marginVertical: 10,
                  }}>
                    {(['out', 'in'] as const).map(d => (
                      <TouchableOpacity
                        key={d}
                        onPress={() => setDir(d)}
                        style={{
                          flex: 1, paddingVertical: 7, borderRadius: 9, alignItems: 'center',
                          backgroundColor: dir === d ? C.ink : 'transparent',
                        }}
                      >
                        <Text style={{ color: dir === d ? '#FFFFFF' : C.muted, fontWeight: '700', fontSize: 12.5 }}>
                          {d === 'out' ? `From ${airportCity}` : `To ${airportCity}`}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 10 }}>
                  {routes.map((f, i) => (
                    <RouteRow key={`${f.id}-${i}`} f={f} accent={accent} />
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
          <Text style={{ color: C.ink, fontWeight: '700', fontSize: 20, letterSpacing: -0.15 }}>Airlines</Text>
          {!loading && airlines.length > 0 && (
            <Text style={{ color: C.muted, fontSize: 11.5 }}>{airlines.length} flying to {airport}</Text>
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
          {airlines.length === 0
            ? 'No airlines found'
            : `${airlines.length} airline${airlines.length === 1 ? '' : 's'} flying to ${airportName}`}
        </Text>
      )}

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 }}>
          <ActivityIndicator size="large" color={accent} />
          <Text style={{ color: C.muted, fontSize: 14 }}>Loading airlines…</Text>
        </View>
      ) : airlines.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8, paddingHorizontal: 24 }}>
          <Text style={{ fontSize: 40 }}>🛫</Text>
          <Text style={{ color: C.secondary, fontWeight: '600', fontSize: 15 }}>No airlines found</Text>
          <Text style={{ color: C.muted, fontSize: 13, textAlign: 'center' }}>Try switching airport</Text>
        </View>
      ) : (
        <FlatList
          data={airlines}
          keyExtractor={a => a.prefix}
          renderItem={({ item }) => (
            <AirlineCard airline={item} onPress={() => setSelected(item)} accent={accent} />
          )}
          contentContainerStyle={{ paddingBottom: 24 }}
          style={{ backgroundColor: C.surface }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={accent} />
          }
        />
      )}

      <BottomSheet airline={selected} airport={airport} onClose={handleClose} />
    </SafeAreaView>
  )
}

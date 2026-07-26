import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { FlightCard } from '../../components/FlightCard'
import { fetchFlights } from '../../lib/api'
import { syriaDate } from '../../lib/constants'
import type { Flight, Airport, View as ViewType } from '../../lib/types'

type DateTab = 'yesterday' | 'today' | 'tomorrow'
type NowDivider = { _now: true; timeStr: string }
type ListItem = Flight | NowDivider

const DATE_LABELS: Record<DateTab, string> = {
  yesterday: 'Yesterday',
  today:     'Today',
  tomorrow:  'Tomorrow',
}

function dateForTab(tab: DateTab): string {
  const offset = tab === 'yesterday' ? -1 : tab === 'tomorrow' ? 1 : 0
  return syriaDate(offset)
}

function shortDate(tab: DateTab): string {
  const iso = dateForTab(tab)
  const [, m, d] = iso.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${parseInt(d)} ${months[parseInt(m) - 1]}`
}

// Returns UTC HH:MM string for sorting/comparing
function flightUtcHHMM(f: Flight, v: ViewType): string {
  const raw = v === 'arr'
    ? (f.actual_arr_utc ?? f.revised_arr_utc ?? f.arr_time_utc)
    : (f.actual_dep_utc ?? f.revised_dep_utc ?? f.dep_time_utc)
  if (!raw) return '00:00'
  return raw.includes('T') ? raw.slice(11, 16) : raw
}

// Minutes from midnight in Syria local time (UTC+3)
function flightSyriaMin(f: Flight, v: ViewType): number {
  const [h, m] = flightUtcHHMM(f, v).split(':').map(Number)
  return ((h + 3) * 60 + m) % 1440
}

function NowLine({ time }: { time: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 10, gap: 10 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: '#9ca3af' }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Ionicons name="time-outline" size={14} color="#9ca3af" />
        <Text style={{ color: '#9ca3af', fontSize: 13, fontWeight: '600' }}>{time} · Now</Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: '#9ca3af' }} />
    </View>
  )
}

export default function BoardScreen() {
  const [airport, setAirport]   = useState<Airport>('DAM')
  const [view, setView]         = useState<ViewType>('arr')
  const [dateTab, setDateTab]   = useState<DateTab>('today')
  const [flights, setFlights]   = useState<Flight[]>([])
  const [loading, setLoading]   = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const flatListRef = useRef<FlatList>(null)

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const all = await fetchFlights(dateForTab(dateTab))
      setFlights(all)
    } catch {
      setError('Failed to load flights. Pull to retry.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [dateTab])

  useEffect(() => { load() }, [load])

  // Sort in Syria local time so midnight wrap is handled correctly
  const sorted = useMemo(() => {
    const filtered = flights.filter(f =>
      view === 'arr' ? f.arr_iata === airport : f.dep_iata === airport
    )
    return [...filtered].sort((a, b) =>
      flightSyriaMin(a, view) - flightSyriaMin(b, view)
    )
  }, [flights, airport, view])

  // Inject Now divider at the correct position (today only)
  const listItems = useMemo((): ListItem[] => {
    if (dateTab !== 'today' || sorted.length === 0) return sorted
    const n = new Date()
    const nowSyriaMin = ((n.getUTCHours() + 3) * 60 + n.getUTCMinutes()) % 1440
    const localH = (n.getUTCHours() + 3) % 24
    const localM = n.getUTCMinutes()
    const nowLocal = `${String(localH).padStart(2, '0')}:${String(localM).padStart(2, '0')}`
    const items: ListItem[] = []
    let inserted = false
    for (const f of sorted) {
      if (!inserted && flightSyriaMin(f, view) > nowSyriaMin) {
        items.push({ _now: true, timeStr: nowLocal })
        inserted = true
      }
      items.push(f)
    }
    if (!inserted) items.push({ _now: true, timeStr: nowLocal })
    return items
  }, [sorted, dateTab, view])

  // Scroll to show one flight above the Now line on initial load
  useEffect(() => {
    if (dateTab !== 'today' || loading || listItems.length === 0) return
    const nowIdx = listItems.findIndex(item => '_now' in item)
    if (nowIdx <= 0) return
    const scrollIdx = Math.max(0, nowIdx - 1)
    const timer = setTimeout(() => {
      flatListRef.current?.scrollToIndex({
        index: scrollIdx,
        animated: true,
        viewPosition: 0,
      })
    }, 400)
    return () => clearTimeout(timer)
  }, [loading, listItems, dateTab])

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#030712' }}>
      {/* Header */}
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 10 }}>

        {/* Date tabs */}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['yesterday', 'today', 'tomorrow'] as DateTab[]).map(dt => (
            <TouchableOpacity
              key={dt}
              onPress={() => setDateTab(dt)}
              style={{
                flex: 1,
                alignItems: 'center',
                paddingVertical: 8,
                borderRadius: 10,
                backgroundColor: dateTab === dt ? '#ffffff' : '#111827',
                borderWidth: 1,
                borderColor: dateTab === dt ? '#ffffff' : '#1f2937',
              }}
            >
              <Text style={{ color: dateTab === dt ? '#030712' : '#9ca3af', fontSize: 13, fontWeight: '600' }}>
                {DATE_LABELS[dt]}
              </Text>
              <Text style={{ color: dateTab === dt ? '#374151' : '#4b5563', fontSize: 11, marginTop: 1 }}>
                {shortDate(dt)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Arr/Dep + Airport on same row */}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1, flexDirection: 'row', backgroundColor: '#111827', borderRadius: 8, padding: 3 }}>
            {([['arr', 'Arrivals'], ['dep', 'Departures']] as [ViewType, string][]).map(([v, label]) => (
              <TouchableOpacity
                key={v}
                onPress={() => setView(v)}
                style={{
                  flex: 1,
                  alignItems: 'center',
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: view === v ? '#ffffff' : 'transparent',
                }}
              >
                <Text style={{ color: view === v ? '#030712' : '#6b7280', fontWeight: '600', fontSize: 13 }}>
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={{ flexDirection: 'row', backgroundColor: '#111827', borderRadius: 8, padding: 3 }}>
            {(['DAM', 'ALP'] as Airport[]).map(ap => (
              <TouchableOpacity
                key={ap}
                onPress={() => setAirport(ap)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: airport === ap ? '#ffffff' : 'transparent',
                }}
              >
                <Text style={{ color: airport === ap ? '#030712' : '#6b7280', fontWeight: '700', fontSize: 13 }}>
                  {ap}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

      </View>

      {/* Content */}
      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color="#38bdf8" />
        </View>
      ) : error ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 }}>
          <Text style={{ color: '#ef4444', textAlign: 'center', fontSize: 14 }}>{error}</Text>
        </View>
      ) : sorted.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 }}>
          <Text style={{ color: '#4b5563', textAlign: 'center', fontSize: 14 }}>
            No {view === 'arr' ? 'arrivals' : 'departures'} for {airport} on {DATE_LABELS[dateTab].toLowerCase()}
          </Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={listItems}
          keyExtractor={(item, i) =>
            '_now' in item
              ? 'now-divider'
              : `${(item as Flight).iata_number}-${(item as Flight).dep_time_utc}-${i}`
          }
          renderItem={({ item }) =>
            '_now' in item
              ? <NowLine time={(item as NowDivider).timeStr} />
              : <FlightCard f={item as Flight} view={view} />
          }
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#38bdf8" />
          }
          onScrollToIndexFailed={({ index }) => {
            // Retry after list has rendered
            setTimeout(() => {
              flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 })
            }, 300)
          }}
          ItemSeparatorComponent={() => <View style={{ height: 2 }} />}
        />
      )}
    </SafeAreaView>
  )
}

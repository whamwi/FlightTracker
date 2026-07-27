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
type NowDivider = { _now: true; timeStr: string; inAir: number; done: number; doneLabel: string }
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

function NowLine({ time, inAir, done, doneLabel }: { time: string; inAir: number; done: number; doneLabel: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 10, gap: 6 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: '#9ca3af' }} />
      {inAir > 0 && (
        <View style={{ backgroundColor: '#0c4a6e', borderRadius: 99, paddingHorizontal: 7, paddingVertical: 2 }}>
          <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: '700' }}>{inAir} in air</Text>
        </View>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Ionicons name="time-outline" size={14} color="#9ca3af" />
        <Text style={{ color: '#9ca3af', fontSize: 13, fontWeight: '600' }}>{time} · Now</Text>
      </View>
      {done > 0 && (
        <View style={{ backgroundColor: '#052e16', borderRadius: 99, paddingHorizontal: 7, paddingVertical: 2 }}>
          <Text style={{ color: '#4ade80', fontSize: 11, fontWeight: '700' }}>{done} {doneLabel}</Text>
        </View>
      )}
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

  // Silent background refresh every 30 s on today's tab (no scroll jerk)
  const silentRefresh = useCallback(async () => {
    try {
      const all = await fetchFlights(dateForTab(dateTab))
      setFlights(all)
    } catch { /* ignore — user can pull-to-refresh if needed */ }
  }, [dateTab])

  useEffect(() => {
    if (dateTab !== 'today') return
    const t = setInterval(silentRefresh, 30_000)
    return () => clearInterval(t)
  }, [dateTab, silentRefresh])

  const arrCount = useMemo(() => flights.filter(f => f.arr_iata === airport).length, [flights, airport])
  const depCount = useMemo(() => flights.filter(f => f.dep_iata === airport).length, [flights, airport])

  const [tabCounts, setTabCounts] = useState<Record<DateTab, number>>({ yesterday: 0, today: 0, tomorrow: 0 })
  useEffect(() => {
    const tabs: DateTab[] = ['yesterday', 'today', 'tomorrow']
    Promise.all(tabs.map(t => fetchFlights(dateForTab(t)))).then(results => {
      const counts = { yesterday: 0, today: 0, tomorrow: 0 } as Record<DateTab, number>
      tabs.forEach((t, i) => {
        counts[t] = results[i].filter(f => f.arr_iata === airport || f.dep_iata === airport).length
      })
      setTabCounts(counts)
    }).catch(() => {})
  }, [airport])

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
    const inAir = sorted.filter(f => ['En Route', 'Departed', 'Approaching'].includes(f.status)).length
    const done  = sorted.filter(f => ['Arrived', 'Landed'].includes(f.status)).length
    const doneLabel = view === 'arr' ? 'arrived' : 'departed'
    const divider: NowDivider = { _now: true, timeStr: nowLocal, inAir, done, doneLabel }
    const items: ListItem[] = []
    let inserted = false
    for (const f of sorted) {
      if (!inserted && flightSyriaMin(f, view) > nowSyriaMin) {
        items.push(divider)
        inserted = true
      }
      items.push(f)
    }
    if (!inserted) items.push(divider)
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
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Text style={{ color: dateTab === dt ? '#030712' : '#9ca3af', fontSize: 13, fontWeight: '600' }}>
                  {DATE_LABELS[dt]}
                </Text>
                {tabCounts[dt] > 0 && (
                  <View style={{
                    backgroundColor: dateTab === dt ? '#111827' : '#1f2937',
                    borderRadius: 99,
                    paddingHorizontal: 5,
                    paddingVertical: 1,
                  }}>
                    <Text style={{ color: dateTab === dt ? '#ffffff' : '#6b7280', fontSize: 10, fontWeight: '700' }}>
                      {tabCounts[dt]}
                    </Text>
                  </View>
                )}
              </View>
              <Text style={{ color: dateTab === dt ? '#374151' : '#4b5563', fontSize: 11, marginTop: 1 }}>
                {shortDate(dt)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Arr/Dep + Airport on same row */}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1, flexDirection: 'row', backgroundColor: '#111827', borderRadius: 8, padding: 3 }}>
            {([['arr', 'Arrivals', arrCount], ['dep', 'Departures', depCount]] as [ViewType, string, number][]).map(([v, label, count]) => (
              <TouchableOpacity
                key={v}
                onPress={() => setView(v)}
                style={{
                  flex: 1,
                  alignItems: 'center',
                  flexDirection: 'row',
                  justifyContent: 'center',
                  gap: 5,
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: view === v ? '#ffffff' : 'transparent',
                }}
              >
                <Text style={{ color: view === v ? '#030712' : '#6b7280', fontWeight: '600', fontSize: 13 }}>
                  {label}
                </Text>
                {count > 0 && (
                  <View style={{
                    backgroundColor: view === v ? '#111827' : '#1f2937',
                    borderRadius: 99,
                    paddingHorizontal: 5,
                    paddingVertical: 1,
                  }}>
                    <Text style={{ color: view === v ? '#ffffff' : '#9ca3af', fontSize: 10, fontWeight: '700' }}>
                      {count}
                    </Text>
                  </View>
                )}
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
              ? <NowLine time={(item as NowDivider).timeStr} inAir={(item as NowDivider).inAir} done={(item as NowDivider).done} doneLabel={(item as NowDivider).doneLabel} />
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

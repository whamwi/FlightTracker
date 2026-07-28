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
import { FlightCard } from '../../components/FlightCard'
import { fetchFlights } from '../../lib/api'
import { syriaDate } from '../../lib/constants'
import type { Flight, Airport, View as ViewType } from '../../lib/types'

// V2 Syria palette tokens
const C = {
  canvas:     '#EDEBE0',
  surface:    '#FFFFFF',
  sunken:     '#F7F5EC',
  track:      '#E4E1D2',
  chipFill:   '#E0DCCB',
  border:     '#D8D3BF',
  ink:        '#161616',
  secondary:  '#3D3A3B',
  muted:      '#8A8578',
  damAccent:  '#054239',
  alpAccent:  '#6B1F2A',
  gold:       '#B9A779',
  inFlight:   '#428177',
  arrivedTint:'#E6EFEC',
  arrivedText:'#002623',
}

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

function flightUtcHHMM(f: Flight, v: ViewType): string {
  const raw = v === 'arr'
    ? (f.actual_arr_utc ?? f.revised_arr_utc ?? f.arr_time_utc)
    : (f.actual_dep_utc ?? f.revised_dep_utc ?? f.dep_time_utc)
  if (!raw) return '00:00'
  return raw.includes('T') ? raw.slice(11, 16) : raw
}

function flightSyriaMin(f: Flight, v: ViewType): number {
  const [h, m] = flightUtcHHMM(f, v).split(':').map(Number)
  return ((h + 3) * 60 + m) % 1440
}

function nowSyriaHHMM(): string {
  const n = new Date()
  const h = (n.getUTCHours() + 3) % 24
  const m = n.getUTCMinutes()
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function NowLine({ time, inAir, done, doneLabel }: { time: string; inAir: number; done: number; doneLabel: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 10, gap: 6 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: C.border }} />

      {/* Time pill */}
      <View style={{ backgroundColor: C.ink, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 3 }}>
        <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '600', fontFamily: 'monospace' }}>{time} NOW</Text>
      </View>

      {/* In air chip — solid Forest */}
      {inAir > 0 && (
        <View style={{ backgroundColor: C.inFlight, borderRadius: 99, paddingHorizontal: 7, paddingVertical: 3 }}>
          <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700' }}>{inAir} in air</Text>
        </View>
      )}

      {/* Done chip — pale tint */}
      {done > 0 && (
        <View style={{ backgroundColor: C.arrivedTint, borderRadius: 99, paddingHorizontal: 7, paddingVertical: 3 }}>
          <Text style={{ color: C.arrivedText, fontSize: 11, fontWeight: '700' }}>{done} {doneLabel}</Text>
        </View>
      )}

      <View style={{ flex: 1, height: 1, backgroundColor: C.border }} />
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
  const [lastUpdated, setLastUpdated] = useState<string>('')
  const flatListRef = useRef<FlatList>(null)

  const accentColor = airport === 'ALP' ? C.alpAccent : C.damAccent

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const all = await fetchFlights(dateForTab(dateTab))
      setFlights(all)
      setLastUpdated(nowSyriaHHMM())
    } catch {
      setError('Failed to load flights. Pull to retry.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [dateTab])

  useEffect(() => { load() }, [load])

  const silentRefresh = useCallback(async () => {
    try {
      const all = await fetchFlights(dateForTab(dateTab))
      setFlights(all)
      setLastUpdated(nowSyriaHHMM())
    } catch { /* ignore */ }
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

  const sorted = useMemo(() => {
    const filtered = flights.filter(f =>
      (view === 'arr' ? f.arr_iata === airport : f.dep_iata === airport) && f.status !== 'Unknown'
    )
    return [...filtered].sort((a, b) => flightSyriaMin(a, view) - flightSyriaMin(b, view))
  }, [flights, airport, view])

  const listItems = useMemo((): ListItem[] => {
    if (dateTab !== 'today' || sorted.length === 0) return sorted
    const n = new Date()
    const nowSyriaMin = ((n.getUTCHours() + 3) * 60 + n.getUTCMinutes()) % 1440
    const nowLocal = nowSyriaHHMM()
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

  useEffect(() => {
    if (dateTab !== 'today' || loading || listItems.length === 0) return
    const nowIdx = listItems.findIndex(item => '_now' in item)
    if (nowIdx <= 0) return
    const scrollIdx = Math.max(0, nowIdx - 1)
    const timer = setTimeout(() => {
      flatListRef.current?.scrollToIndex({ index: scrollIdx, animated: true, viewPosition: 0 })
    }, 400)
    return () => clearTimeout(timer)
  }, [loading, listItems, dateTab])

  const airportName = airport === 'DAM' ? 'Damascus' : 'Aleppo'

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.canvas }}>

      {/* Header block — white surface */}
      <View style={{
        backgroundColor: C.surface,
        paddingHorizontal: 14, paddingTop: 6, paddingBottom: 12,
        gap: 10,
        borderBottomWidth: 1, borderBottomColor: C.border,
        shadowColor: C.ink,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.08,
        shadowRadius: 14,
        elevation: 4,
      }}>

        {/* Title row */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <Text style={{ color: C.ink, fontWeight: '700', fontSize: 17, letterSpacing: -0.1 }}>{airportName}</Text>
            <Text style={{ color: accentColor, fontWeight: '600', fontSize: 12, fontFamily: 'monospace' }}>{airport}</Text>
          </View>
          {lastUpdated ? (
            <Text style={{ color: C.muted, fontSize: 11, fontWeight: '500' }}>updated {lastUpdated}</Text>
          ) : null}
        </View>

        {/* Date tabs */}
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {(['yesterday', 'today', 'tomorrow'] as DateTab[]).map(dt => {
            const active = dateTab === dt
            return (
              <TouchableOpacity
                key={dt}
                onPress={() => setDateTab(dt)}
                style={{
                  flex: 1,
                  alignItems: 'center',
                  paddingVertical: 8,
                  paddingBottom: 9,
                  borderRadius: 12,
                  backgroundColor: active ? C.ink : C.track,
                  borderWidth: active ? 0 : 1,
                  borderColor: C.border,
                  shadowColor: C.ink,
                  shadowOffset: { width: 0, height: active ? 6 : 0 },
                  shadowOpacity: active ? 0.55 : 0,
                  shadowRadius: active ? 14 : 0,
                  elevation: active ? 4 : 0,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Text style={{ color: active ? '#FFFFFF' : C.secondary, fontSize: 12.5, fontWeight: '600' }}>
                    {DATE_LABELS[dt]}
                  </Text>
                  {tabCounts[dt] > 0 && (
                    <View style={{
                      backgroundColor: active ? C.gold : C.chipFill,
                      borderRadius: 99, paddingHorizontal: 5, paddingVertical: 1,
                    }}>
                      <Text style={{ color: active ? C.ink : C.muted, fontSize: 10, fontWeight: '600', fontFamily: 'monospace' }}>
                        {tabCounts[dt]}
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={{ color: active ? 'rgba(255,255,255,0.6)' : C.muted, fontSize: 10, fontFamily: 'monospace', marginTop: 1 }}>
                  {shortDate(dt)}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>

        {/* Arr/Dep + Airport toggles */}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {/* Arrivals / Departures */}
          <View style={{ flex: 1, flexDirection: 'row', backgroundColor: C.track, borderRadius: 11, padding: 3 }}>
            {([['arr', 'Arrivals', arrCount], ['dep', 'Departures', depCount]] as [ViewType, string, number][]).map(([v, label, count]) => {
              const active = view === v
              return (
                <TouchableOpacity
                  key={v}
                  onPress={() => setView(v)}
                  style={{
                    flex: 1, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 5,
                    paddingVertical: 6, borderRadius: 9,
                    backgroundColor: active ? C.surface : 'transparent',
                    shadowColor: C.ink,
                    shadowOffset: { width: 0, height: active ? 1 : 0 },
                    shadowOpacity: active ? 0.14 : 0,
                    shadowRadius: active ? 3 : 0,
                    elevation: active ? 2 : 0,
                  }}
                >
                  <Text style={{ color: active ? C.ink : C.muted, fontWeight: '600', fontSize: 12.5 }}>{label}</Text>
                  {count > 0 && (
                    <View style={{
                      backgroundColor: active ? C.chipFill : 'transparent',
                      borderRadius: 99, paddingHorizontal: 5, paddingVertical: 1,
                    }}>
                      <Text style={{ color: active ? C.secondary : C.muted, fontSize: 10, fontWeight: '600' }}>{count}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              )
            })}
          </View>

          {/* DAM / ALP */}
          <View style={{ flexDirection: 'row', backgroundColor: C.track, borderRadius: 11, padding: 3 }}>
            {(['DAM', 'ALP'] as Airport[]).map(ap => {
              const active = airport === ap
              const apAccent = ap === 'ALP' ? C.alpAccent : C.damAccent
              return (
                <TouchableOpacity
                  key={ap}
                  onPress={() => setAirport(ap)}
                  style={{
                    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 9,
                    backgroundColor: active ? apAccent : 'transparent',
                  }}
                >
                  <Text style={{ color: active ? '#FFFFFF' : C.muted, fontWeight: '700', fontSize: 12, fontFamily: 'monospace', letterSpacing: 0.6 }}>
                    {ap}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </View>
        </View>
      </View>

      {/* Content */}
      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={accentColor} />
        </View>
      ) : error ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 }}>
          <Text style={{ color: '#4A151E', textAlign: 'center', fontSize: 14 }}>{error}</Text>
        </View>
      ) : sorted.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 }}>
          <Text style={{ color: C.muted, textAlign: 'center', fontSize: 14 }}>
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
          contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 24 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={accentColor} />
          }
          onScrollToIndexFailed={({ index }) => {
            setTimeout(() => {
              flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 })
            }, 300)
          }}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        />
      )}
    </SafeAreaView>
  )
}

import { useState, useEffect, useCallback } from 'react'
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

type DateTab = 'yesterday' | 'today' | 'tomorrow'

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

export default function BoardScreen() {
  const [airport, setAirport]   = useState<Airport>('DAM')
  const [view, setView]         = useState<ViewType>('arr')
  const [dateTab, setDateTab]   = useState<DateTab>('today')
  const [flights, setFlights]   = useState<Flight[]>([])
  const [loading, setLoading]   = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const date = dateForTab(dateTab)
      const all = await fetchFlights(date)
      setFlights(all)
    } catch (e) {
      setError('Failed to load flights. Pull to retry.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [dateTab])

  useEffect(() => { load() }, [load])

  const filtered = flights.filter(f => {
    const matchAirport = view === 'arr' ? f.arr_iata === airport : f.dep_iata === airport
    return matchAirport
  })

  const sorted = [...filtered].sort((a, b) => {
    const ta = view === 'arr'
      ? (a.actual_arr_utc ?? a.revised_arr_utc ?? a.arr_time_utc)
      : (a.actual_dep_utc ?? a.revised_dep_utc ?? a.dep_time_utc)
    const tb = view === 'arr'
      ? (b.actual_arr_utc ?? b.revised_arr_utc ?? b.arr_time_utc)
      : (b.actual_dep_utc ?? b.revised_dep_utc ?? b.dep_time_utc)
    return ta.localeCompare(tb)
  })

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
          {/* Arrivals / Departures pill */}
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

          {/* DAM / ALP pill */}
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
          data={sorted}
          keyExtractor={(f, i) => `${f.iata_number}-${f.dep_time_utc}-${i}`}
          renderItem={({ item }) => <FlightCard f={item} view={view} />}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load(true)}
              tintColor="#38bdf8"
            />
          }
          ItemSeparatorComponent={() => <View style={{ height: 2 }} />}
        />
      )}
    </SafeAreaView>
  )
}

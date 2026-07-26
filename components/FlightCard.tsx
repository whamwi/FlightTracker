import { View, Text, Image } from 'react-native'
import type { Flight, View as ViewType } from '../lib/types'
import { city, airportFlag, statusConfig, durationLabel, fmtLocal, tzOffset, airlineLogo, LOGO_WHITE_BG } from '../lib/constants'

function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig(status)
  return (
    <View style={{ backgroundColor: cfg.bg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99 }}>
      <Text style={{ color: cfg.text, fontSize: 12, fontWeight: '600' }}>{cfg.label}</Text>
    </View>
  )
}

function DelayBadge({ min }: { min: number | null }) {
  if (!min || Math.abs(min) < 1) return null
  const color = min > 0 ? '#ef4444' : '#22c55e'
  return (
    <View style={{ backgroundColor: '#1f2937', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, marginTop: 2, alignSelf: 'flex-start' }}>
      <Text style={{ color, fontSize: 12, fontWeight: '600' }}>{min > 0 ? `+${min}m` : `${min}m`}</Text>
    </View>
  )
}

function calcDelay(sched: string | null | undefined, actual: string | null | undefined): number | null {
  if (!sched || !actual) return null
  return Math.round((new Date(actual).getTime() - new Date(sched).getTime()) / 60_000)
}

export function FlightCard({ f, view }: { f: Flight; view: ViewType }) {
  const isArr = view === 'arr'
  const cfg   = statusConfig(f.status)

  const depOff = isArr ? tzOffset(f.dep_iata) : 3
  const arrOff = isArr ? 3 : tzOffset(f.arr_iata)

  const depTime = f.actual_dep_utc  ? fmtLocal(f.actual_dep_utc,  depOff)
                : f.revised_dep_utc ? fmtLocal(f.revised_dep_utc, depOff)
                :                     fmtLocal(f.dep_time_utc,    depOff)
  const arrTime = f.actual_arr_utc  ? fmtLocal(f.actual_arr_utc,  arrOff)
                : f.revised_arr_utc ? fmtLocal(f.revised_arr_utc, arrOff)
                :                     fmtLocal(f.arr_time_utc,    arrOff)

  const depDelay = calcDelay(f.dep_time_utc, f.actual_dep_utc ?? f.revised_dep_utc)
  const arrDelay = calcDelay(f.arr_time_utc, f.actual_arr_utc ?? f.revised_arr_utc)

  const depColor = f.actual_dep_utc ? '#4ade80' : f.revised_dep_utc ? '#facc15' : '#ffffff'
  const arrColor = f.actual_arr_utc ? '#4ade80' : f.revised_arr_utc ? '#facc15' : '#ffffff'

  return (
    <View
      style={{
        backgroundColor: '#111827',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#1f2937',
        borderLeftWidth: 3,
        borderLeftColor: cfg.border,
        marginBottom: 10,
        overflow: 'hidden',
      }}
    >
      <View style={{ padding: 16, gap: 14 }}>

        {/* Row 1: airline logo + name + status */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8, gap: 10 }}>
            <View style={{
              width: 36, height: 36, borderRadius: 12, overflow: 'hidden',
              backgroundColor: LOGO_WHITE_BG.has(f.airline_iata) ? '#ffffff' : '#1f2937',
              justifyContent: 'center', alignItems: 'center',
            }}>
              <Image
                source={{ uri: airlineLogo(f.airline_iata) }}
                style={{ width: 36, height: 36, borderRadius: 12 }}
                resizeMode="contain"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#ffffff', fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                {f.airline_name}
              </Text>
              <Text style={{ color: '#9ca3af', fontSize: 12, fontFamily: 'monospace', marginTop: 1 }}>
                {f.iata_number}
              </Text>
            </View>
          </View>
          <StatusBadge status={f.status} />
        </View>

        {/* Row 2: route */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ minWidth: 72 }}>
            <Text style={{ color: '#ffffff', fontWeight: '700', fontSize: 14 }} numberOfLines={1}>
              {airportFlag(f.dep_iata)} {city(f.dep_iata)}
            </Text>
            <Text style={{ color: '#6b7280', fontSize: 12, fontFamily: 'monospace', textAlign: 'center', marginTop: 1 }}>
              {f.dep_iata}
            </Text>
          </View>

          <View style={{ flex: 1, alignItems: 'center', gap: 3 }}>
            {f.duration_min > 0 && (
              <Text style={{ color: '#4b5563', fontSize: 12 }}>{durationLabel(f.duration_min)}</Text>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', width: '100%' }}>
              <View style={{ flex: 1, height: 1, backgroundColor: '#374151' }} />
              <Text style={{ color: '#4b5563', fontSize: 12, marginHorizontal: 4 }}>✈</Text>
              <View style={{ flex: 1, height: 1, backgroundColor: '#374151' }} />
            </View>
          </View>

          <View style={{ minWidth: 72, alignItems: 'flex-end' }}>
            <Text style={{ color: '#ffffff', fontWeight: '700', fontSize: 14, textAlign: 'right' }} numberOfLines={1}>
              {airportFlag(f.arr_iata)} {city(f.arr_iata)}
            </Text>
            <Text style={{ color: '#6b7280', fontSize: 12, fontFamily: 'monospace', textAlign: 'center', marginTop: 1 }}>
              {f.arr_iata}
            </Text>
          </View>
        </View>

        {/* Row 3: times */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <View>
            <Text style={{ color: '#6b7280', fontSize: 12, marginBottom: 2 }}>Departure</Text>
            <Text style={{ color: depColor, fontWeight: '600', fontSize: 17, fontFamily: 'monospace' }}>{depTime}</Text>
            <DelayBadge min={depDelay} />
          </View>

          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            {f.aircraft_type ? (
              <Text style={{ color: '#4b5563', fontSize: 12 }}>{f.aircraft_type}</Text>
            ) : null}
            {(isArr ? f.arr_gate : f.dep_gate) ? (
              <Text style={{ color: '#6b7280', fontSize: 12 }}>Gate {isArr ? f.arr_gate : f.dep_gate}</Text>
            ) : null}
          </View>

          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: '#6b7280', fontSize: 12, marginBottom: 2 }}>Arrival</Text>
            <Text style={{ color: arrColor, fontWeight: '600', fontSize: 17, fontFamily: 'monospace' }}>{arrTime}</Text>
            {isArr && <DelayBadge min={arrDelay} />}
          </View>
        </View>

      </View>
    </View>
  )
}

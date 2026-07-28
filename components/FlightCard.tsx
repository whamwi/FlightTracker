import { useState, useEffect } from 'react'
import { View, Text, Image } from 'react-native'
import type { Flight, View as ViewType } from '../lib/types'
import { city, airportFlag, statusConfig, durationLabel, fmtLocal, tzOffset, airlineLogo, LOGO_WHITE_BG } from '../lib/constants'

const IN_FLIGHT = new Set(['En Route', 'Departed', 'Approaching'])

function ProgressRoute({ depUtc, durationMin }: { depUtc: string; durationMin: number }) {
  const calc = () => {
    const dep = new Date(depUtc).getTime()
    return Math.min(100, Math.max(0, ((Date.now() - dep) / (durationMin * 60_000)) * 100))
  }
  const [pct, setPct] = useState(calc)
  useEffect(() => {
    const t = setInterval(() => setPct(calc()), 30_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depUtc, durationMin])

  const remainingMin = Math.round((1 - pct / 100) * durationMin)
  const fill  = Math.max(0.5, pct)
  const empty = Math.max(0.5, 100 - pct)

  return (
    <View style={{ width: '100%', alignItems: 'center', gap: 3 }}>
      <Text style={{ color: '#9ca3af', fontSize: 12 }}>
        {remainingMin > 0 ? durationLabel(remainingMin) : 'Arriving'}
      </Text>
      <View style={{ flexDirection: 'row', width: '100%', alignItems: 'center', height: 24 }}>
        <View style={{ flex: fill,  height: 1, backgroundColor: '#0284c7' }} />
        <Text style={{ color: '#0284c7', fontSize: 20 }}>✈</Text>
        <View style={{ flex: empty, height: 1, backgroundColor: '#d1d5db' }} />
      </View>
    </View>
  )
}

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
  const color = min > 0 ? '#dc2626' : '#16a34a'
  return (
    <View style={{ backgroundColor: '#f3f4f6', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, marginTop: 2, alignSelf: 'flex-start' }}>
      <Text style={{ color, fontSize: 12, fontWeight: '600' }}>{min > 0 ? `+${min}m` : `${min}m`}</Text>
    </View>
  )
}

function calcDelay(schedHHMM: string | null | undefined, actual: string | null | undefined): number | null {
  if (!schedHHMM || !actual) return null
  const opDate   = actual.slice(0, 10)
  const actualMs = new Date(actual).getTime()
  if (isNaN(actualMs)) return null
  let schedMs = new Date(`${opDate}T${schedHHMM}:00Z`).getTime()
  if (schedMs - actualMs > 12 * 3_600_000) schedMs -= 86_400_000
  return Math.round((actualMs - schedMs) / 60_000)
}

export function FlightCard({ f, view, hideBadge, photoUrl }: { f: Flight; view: ViewType; hideBadge?: boolean; photoUrl?: string | null }) {
  const isArr      = view === 'arr'
  const cfg        = statusConfig(f.status)
  const showProgress = IN_FLIGHT.has(f.status) && !!f.actual_dep_utc && f.duration_min > 0

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

  const depColor = f.actual_dep_utc ? '#16a34a' : f.revised_dep_utc ? '#d97706' : '#111827'
  const arrColor = f.actual_arr_utc ? '#16a34a' : f.revised_arr_utc ? '#d97706' : '#111827'

  return (
    <View
      style={{
        backgroundColor: '#ffffff',
        borderRadius: 16,
        borderWidth: 1,
        borderColor: '#e5e7eb',
        borderLeftWidth: 3,
        borderLeftColor: cfg.border,
        marginBottom: 10,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.08,
        shadowRadius: 8,
        elevation: 3,
      }}
    >
      <View style={{ padding: 16, gap: 14 }}>

        {/* Row 1: airline logo + name + status */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8, gap: 10 }}>
            <View style={{
              width: 36, height: 36, borderRadius: 12, overflow: 'hidden',
              backgroundColor: LOGO_WHITE_BG.has(f.airline_iata) ? '#f3f4f6' : '#f9fafb',
              justifyContent: 'center', alignItems: 'center',
              borderWidth: 1, borderColor: '#e5e7eb',
            }}>
              <Image
                source={{ uri: airlineLogo(f.airline_iata) }}
                style={{ width: 36, height: 36, borderRadius: 12 }}
                resizeMode="contain"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#111827', fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                {f.airline_name}
              </Text>
              <Text style={{ color: '#9ca3af', fontSize: 12, fontFamily: 'monospace', marginTop: 1 }}>
                {f.iata_number}
              </Text>
            </View>
          </View>
          {!hideBadge && <StatusBadge status={f.status} />}
        </View>

        {/* Row 2: route */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ minWidth: 72 }}>
            <Text style={{ color: '#111827', fontWeight: '700', fontSize: 14 }} numberOfLines={1}>
              {airportFlag(f.dep_iata)} {city(f.dep_iata)}
            </Text>
            <Text style={{ color: '#9ca3af', fontSize: 12, fontFamily: 'monospace', textAlign: 'center', marginTop: 1, alignSelf: 'stretch' }}>
              {f.dep_iata}
            </Text>
          </View>

          <View style={{ flex: 1, alignItems: 'center', gap: 3 }}>
            {showProgress ? (
              <ProgressRoute depUtc={f.actual_dep_utc!} durationMin={f.duration_min} />
            ) : (
              <>
                {f.duration_min > 0 && (
                  <Text style={{ color: '#9ca3af', fontSize: 12 }}>{durationLabel(f.duration_min)}</Text>
                )}
                <View style={{ flexDirection: 'row', alignItems: 'center', width: '100%' }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: '#d1d5db' }} />
                  <Text style={{ color: '#9ca3af', fontSize: 12, marginHorizontal: 4 }}>✈</Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: '#d1d5db' }} />
                </View>
              </>
            )}
          </View>

          <View style={{ minWidth: 72, alignItems: 'flex-end' }}>
            <Text style={{ color: '#111827', fontWeight: '700', fontSize: 14, textAlign: 'right' }} numberOfLines={1}>
              {airportFlag(f.arr_iata)} {city(f.arr_iata)}
            </Text>
            <Text style={{ color: '#9ca3af', fontSize: 12, fontFamily: 'monospace', textAlign: 'center', marginTop: 1, alignSelf: 'stretch' }}>
              {f.arr_iata}
            </Text>
          </View>
        </View>

        {/* Aircraft photo */}
        {photoUrl && (
          <View style={{ borderRadius: 10, overflow: 'hidden', height: 130 }}>
            <Image
              source={{ uri: photoUrl }}
              style={{ width: '100%', height: 130 }}
              resizeMode="cover"
            />
          </View>
        )}

        {/* Divider */}
        <View style={{ height: 1, backgroundColor: '#f3f4f6' }} />

        {/* Row 3: times */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <View>
            <Text style={{ color: '#9ca3af', fontSize: 11, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.5 }}>Departure</Text>
            <Text style={{ color: depColor, fontWeight: '700', fontSize: 18, fontFamily: 'monospace' }}>{depTime}</Text>
            <DelayBadge min={depDelay} />
          </View>

          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            {f.aircraft_type ? (
              <Text style={{ color: '#9ca3af', fontSize: 12 }}>{f.aircraft_type}</Text>
            ) : null}
            {(isArr ? f.arr_gate : f.dep_gate) ? (
              <Text style={{ color: '#6b7280', fontSize: 12 }}>Gate {isArr ? f.arr_gate : f.dep_gate}</Text>
            ) : null}
          </View>

          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: '#9ca3af', fontSize: 11, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.5 }}>Arrival</Text>
            <Text style={{ color: arrColor, fontWeight: '700', fontSize: 18, fontFamily: 'monospace' }}>{arrTime}</Text>
            {isArr && <DelayBadge min={arrDelay} />}
          </View>
        </View>

      </View>
    </View>
  )
}

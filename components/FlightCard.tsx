import { useState, useEffect } from 'react'
import { View, Text, Image } from 'react-native'
import type { Flight, View as ViewType } from '../lib/types'
import { city, airportFlag, statusConfig, durationLabel, fmtLocal, tzOffset, airlineLogo, LOGO_WHITE_BG } from '../lib/constants'

const IN_FLIGHT = new Set(['En Route', 'Departed', 'Approaching'])

const C = {
  ink:        '#161616',
  secondary:  '#3D3A3B',
  muted:      '#8A8578',
  surface:    '#FFFFFF',
  sunken:     '#F7F5EC',
  logoBg:     '#F7F5EC',
  border:     '#D8D3BF',
  separator:  '#D8D3BF',
  trackEmpty: '#E0DCCB',
  trackFill:  '#428177',
  arrivedRail:'#9EBFB8',
}

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
      <Text style={{ color: C.muted, fontSize: 10.5, fontFamily: 'monospace' }}>
        {remainingMin > 0 ? `${durationLabel(remainingMin)} left` : 'Arriving'}
      </Text>
      <View style={{ flexDirection: 'row', width: '100%', alignItems: 'center', height: 20 }}>
        <View style={{ flex: fill, height: 4, borderRadius: 99, backgroundColor: C.trackFill }} />
        <View style={{
          width: 18, height: 18, borderRadius: 9,
          backgroundColor: C.surface,
          borderWidth: 1.5, borderColor: C.trackFill,
          justifyContent: 'center', alignItems: 'center',
          shadowColor: C.trackFill, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.35, shadowRadius: 4,
          elevation: 2,
        }}>
          <Text style={{ color: C.trackFill, fontSize: 9 }}>✈</Text>
        </View>
        <View style={{ flex: empty, height: 4, borderRadius: 99, backgroundColor: C.trackEmpty }} />
      </View>
    </View>
  )
}

function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig(status)
  return (
    <View style={{ backgroundColor: cfg.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99, flexShrink: 0 }}>
      <Text style={{ color: cfg.text, fontSize: 11, fontWeight: '600' }}>{cfg.label}</Text>
    </View>
  )
}

function DelayChip({ min }: { min: number | null }) {
  if (!min || Math.abs(min) < 1) return null
  const isLate = min > 0
  return (
    <View style={{
      backgroundColor: isLate ? '#F1E6E7' : '#E6EFEC',
      borderRadius: 5,
      paddingHorizontal: 5, paddingVertical: 2,
      marginTop: 2, alignSelf: 'flex-start',
    }}>
      <Text style={{ color: isLate ? '#4A151E' : '#002623', fontSize: 10, fontWeight: '600', fontFamily: 'monospace' }}>
        {min > 0 ? `+${min}m` : `${min}m`}
      </Text>
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


export function FlightCard({ f, view, hideBadge, photoUrl, depDelayMin, arrDelayMin, bare }: {
  f: Flight; view: ViewType; hideBadge?: boolean; bare?: boolean
  photoUrl?: string | null; depDelayMin?: number | null; arrDelayMin?: number | null
}) {
  const isArr = view === 'arr'
  const cfg   = statusConfig(f.status)
  const showProgress = IN_FLIGHT.has(f.status) && !!f.actual_dep_utc && f.duration_min > 0
  const isArrived = f.status === 'Arrived'

  const depOff = isArr ? tzOffset(f.dep_iata) : 3
  const arrOff = isArr ? 3 : tzOffset(f.arr_iata)

  const depTime = f.actual_dep_utc  ? fmtLocal(f.actual_dep_utc,  depOff)
                : f.revised_dep_utc ? fmtLocal(f.revised_dep_utc, depOff)
                :                     fmtLocal(f.dep_time_utc,    depOff)
  const arrTime = f.actual_arr_utc  ? fmtLocal(f.actual_arr_utc,  arrOff)
                : f.revised_arr_utc ? fmtLocal(f.revised_arr_utc, arrOff)
                :                     fmtLocal(f.arr_time_utc,    arrOff)

  const depDelay = depDelayMin !== undefined ? depDelayMin : calcDelay(f.dep_time_utc, f.actual_dep_utc ?? f.revised_dep_utc)
  const arrDelay = arrDelayMin !== undefined ? arrDelayMin : calcDelay(f.arr_time_utc, f.actual_arr_utc ?? f.revised_arr_utc)

  const depTimeColor = f.actual_dep_utc ? '#002623' : f.revised_dep_utc ? '#6E5F3C' : C.ink
  const arrTimeColor = f.actual_arr_utc ? '#002623' : f.revised_arr_utc ? '#6E5F3C' : C.ink
  const railColor    = cfg.border

  // Horizontal padding — bare mode is symmetric; card mode offsets left for the 4px rail
  const pl = bare ? 16 : 17
  const pr = 14

  const inner = (
    <>
      {/* Header: logo · airline + flight no · status badge */}
      <View style={{ paddingTop: 14, paddingRight: pr, paddingBottom: 12, paddingLeft: pl, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{
          width: 44, height: 44, borderRadius: 12, overflow: 'hidden',
          backgroundColor: LOGO_WHITE_BG.has(f.airline_iata) ? C.surface : C.logoBg,
          justifyContent: 'center', alignItems: 'center',
          borderWidth: 1, borderColor: C.border,
        }}>
          <Image source={{ uri: airlineLogo(f.airline_iata) }} style={{ width: 44, height: 44 }} resizeMode="contain" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.ink, fontWeight: '700', fontSize: 16 }} numberOfLines={1}>{f.airline_name}</Text>
          <Text style={{ color: C.muted, fontSize: 11.5, fontFamily: 'monospace', marginTop: 1, letterSpacing: 0.5 }}>
            {f.iata_number}{f.aircraft_type ? ` · ${f.aircraft_type}` : ''}
          </Text>
        </View>
        {!hideBadge && <StatusBadge status={f.status} />}
      </View>

      {/* Route: dep → progress → arr */}
      <View style={{ paddingRight: pr, paddingBottom: 14, paddingLeft: pl, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ minWidth: 60 }}>
          <Text style={{ color: C.ink, fontWeight: '600', fontSize: 13.5, fontFamily: 'monospace' }}>
            {airportFlag(f.dep_iata)} {f.dep_iata}
          </Text>
          <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{city(f.dep_iata)}</Text>
        </View>

        <View style={{ flex: 1, alignItems: 'center', gap: 3 }}>
          {showProgress ? (
            <ProgressRoute depUtc={f.actual_dep_utc!} durationMin={f.duration_min} />
          ) : (
            <>
              {f.duration_min > 0 && (
                <Text style={{ color: C.muted, fontSize: 10.5, fontFamily: 'monospace' }}>{durationLabel(f.duration_min)}</Text>
              )}
              <View style={{ flexDirection: 'row', alignItems: 'center', width: '100%' }}>
                <View style={{ flex: 1, height: 4, borderRadius: 99, backgroundColor: isArrived ? C.arrivedRail : C.trackEmpty }} />
                <Text style={{ color: C.muted, fontSize: 14, paddingHorizontal: 6 }}>✈</Text>
                <View style={{ flex: 1, height: 4, borderRadius: 99, backgroundColor: C.trackEmpty }} />
              </View>
            </>
          )}
        </View>

        <View style={{ minWidth: 60, alignItems: 'flex-end' }}>
          <Text style={{ color: C.ink, fontWeight: '600', fontSize: 13.5, fontFamily: 'monospace', textAlign: 'right' }}>
            {f.arr_iata} {airportFlag(f.arr_iata)}
          </Text>
          <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{city(f.arr_iata)}</Text>
        </View>
      </View>

      {/* Aircraft photo — placeholder filtering is done upstream (realPhoto in map.tsx) */}
      {photoUrl && (
        <View style={bare
          ? { marginHorizontal: 14, marginBottom: 14, borderRadius: 14, overflow: 'hidden', height: 130 }
          : { marginRight: 12, marginBottom: 12, marginLeft: 17, borderRadius: 14, overflow: 'hidden', height: 130 }
        }>
          <Image source={{ uri: photoUrl }} style={{ width: '100%', height: 130 }} resizeMode="cover" />
        </View>
      )}

      {/* Times footer — sunken warm bg */}
      {!bare && <View style={{ height: 1, backgroundColor: C.separator }} />}
      <View style={{
        backgroundColor: C.sunken,
        paddingTop: 10, paddingRight: pr, paddingBottom: bare ? 36 : 12, paddingLeft: pl,
        flexDirection: 'row',
        justifyContent: 'space-between',
      }}>
        <View>
          <Text style={{ color: C.muted, fontSize: 9, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 2 }}>
            Departure
          </Text>
          <Text style={{ color: depTimeColor, fontWeight: '600', fontSize: 20, fontFamily: 'monospace' }}>{depTime}</Text>
          <DelayChip min={depDelay} />
        </View>
        <View style={{ alignItems: 'center', justifyContent: 'center' }}>
          {(isArr ? f.arr_gate : f.dep_gate) ? (
            <Text style={{ color: C.secondary, fontSize: 11 }}>Gate {isArr ? f.arr_gate : f.dep_gate}</Text>
          ) : null}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ color: C.muted, fontSize: 9, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 2 }}>
            Arrival
          </Text>
          <Text style={{ color: arrTimeColor, fontWeight: '600', fontSize: 20, fontFamily: 'monospace' }}>{arrTime}</Text>
          {isArr && <DelayChip min={arrDelay} />}
        </View>
      </View>
    </>
  )

  // bare = content sits directly on the sheet, no outer card wrapper or status rail
  if (bare) return <>{inner}</>

  return (
    <View style={{
      backgroundColor: C.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: C.border,
      overflow: 'hidden',
      shadowColor: C.ink,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 2,
      elevation: 2,
    }}>
      {/* Status rail — absolute left strip */}
      <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: railColor, zIndex: 1 }} />
      {inner}
    </View>
  )
}

import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native'
import MapView, { Marker, UrlTile, Circle, PROVIDER_DEFAULT } from 'react-native-maps'
import { FlightCard } from '../../components/FlightCard'
import type { Flight } from '../../lib/types'

const BASE = 'https://flighttracker-sy.vercel.app'

// ── Airport coords ────────────────────────────────────────────────────────────
const AIRPORT: Record<string, [number, number]> = {
  DAM:[33.4114,36.5156], ALP:[36.1807,37.2244], LTK:[35.4011,35.9488],
  SAW:[40.8986,29.3092], IST:[41.2608,28.7418], AYT:[36.8987,30.7995],
  AMM:[31.7226,35.9930], BEY:[33.8208,35.4883], CAI:[30.1219,31.4056],
  HRG:[27.1783,33.7993], DXB:[25.2528,55.3644], SHJ:[25.3285,55.5172],
  AUH:[24.4330,54.6511], KWI:[29.2267,47.9689], MCT:[23.5933,58.2844],
  RUH:[24.9578,46.6989], JED:[21.6796,39.1565], BGW:[33.2626,44.2346],
  BSR:[30.5491,47.6622], TBS:[41.6692,44.9547], GYD:[40.4675,50.0467],
  DOH:[25.2731,51.6081], BAH:[26.2708,50.6336], ESB:[40.1281,32.9951],
  NJF:[31.9890,44.4042], EBL:[36.2376,43.9631], VIE:[48.1103,16.5697],
  AMS:[52.3086, 4.7639], THR:[35.6892,51.3130], MHD:[36.2352,59.6400],
  DMM:[26.4712,49.7979], MED:[24.5534,39.7051], ADB:[38.2924,27.1570],
  MJI:[32.8942,13.2759], ATH:[37.9364,23.9445], SVO:[55.9736,37.4125],
  SKD:[39.7005,66.9838], TAS:[41.2579,69.2812], EVN:[40.1473,44.3959],
}

const SYRIA = new Set(['DAM', 'ALP', 'LTK', 'DEZ'])

// Serviced airports — shown as dashed circles on the map (matches web)
const SERVICED: { latitude: number; longitude: number; iata: string }[] = [
  { latitude: 33.4114, longitude: 36.5156, iata: 'DAM' },
  { latitude: 36.1807, longitude: 37.2244, iata: 'ALP' },
  { latitude: 35.2854, longitude: 40.1760, iata: 'DEZ' },
  { latitude: 31.7226, longitude: 35.9930, iata: 'AMM' },
  { latitude: 52.3086, longitude:  4.7639, iata: 'AMS' },
  { latitude: 24.4330, longitude: 54.6511, iata: 'AUH' },
  { latitude: 33.2626, longitude: 44.2346, iata: 'BGW' },
  { latitude: 26.4712, longitude: 49.7979, iata: 'DMM' },
  { latitude: 25.2731, longitude: 51.6081, iata: 'DOH' },
  { latitude: 25.2528, longitude: 55.3644, iata: 'DXB' },
  { latitude: 36.2376, longitude: 43.9631, iata: 'EBL' },
  { latitude: 40.1281, longitude: 32.9951, iata: 'ESB' },
  { latitude: 41.2608, longitude: 28.7418, iata: 'IST' },
  { latitude: 21.6796, longitude: 39.1565, iata: 'JED' },
  { latitude: 29.2267, longitude: 47.9689, iata: 'KWI' },
  { latitude: 23.5933, longitude: 58.2844, iata: 'MCT' },
  { latitude: 32.8942, longitude: 13.2759, iata: 'MJI' },
  { latitude: 44.5711, longitude: 26.0850, iata: 'OTP' },
  { latitude: 24.9578, longitude: 46.6989, iata: 'RUH' },
  { latitude: 40.8986, longitude: 29.3092, iata: 'SAW' },
  { latitude: 25.3285, longitude: 55.5172, iata: 'SHJ' },
]

// ── Airline lookups ───────────────────────────────────────────────────────────
const ICAO_TO_IATA: Record<string, string> = {
  FDB:'FZ', ABY:'G9', THY:'TK', RJA:'RJ',
  QTR:'QR', ETD:'EY', PGT:'PC', SYR:'RB',
  JZR:'J9', FYC:'XH', UAE:'EK',
}
const AIRLINE_NAME: Record<string, string> = {
  G9:'Air Arabia',      FZ:'flydubai',
  TK:'Turkish Airlines',RB:'Syrianair',
  XH:'Cham Wings',      J9:'Jazeera Airways',
  EY:'Etihad Airways',  PC:'Pegasus Airlines',
  QR:'Qatar Airways',   EK:'Emirates',
  RJ:'Royal Jordanian', WY:'Oman Air',
  GF:'Gulf Air',        J2:'Azerbaijan Airlines',
}

// ── Geometry ──────────────────────────────────────────────────────────────────
type Waypoint = { f: number; lat: number; lon: number }

function slerpGreatCircle(lat1: number, lon1: number, lat2: number, lon2: number, f: number): [number, number] {
  const r=Math.PI/180
  const φ1=lat1*r,λ1=lon1*r,φ2=lat2*r,λ2=lon2*r
  const x1=Math.cos(φ1)*Math.cos(λ1),y1=Math.cos(φ1)*Math.sin(λ1),z1=Math.sin(φ1)
  const x2=Math.cos(φ2)*Math.cos(λ2),y2=Math.cos(φ2)*Math.sin(λ2),z2=Math.sin(φ2)
  const dot=Math.min(1,Math.max(-1,x1*x2+y1*y2+z1*z2))
  const omega=Math.acos(dot)
  if (Math.abs(omega)<1e-6) return [lat1,lon1]
  const s=Math.sin(omega)
  const w1=Math.sin((1-f)*omega)/s,w2=Math.sin(f*omega)/s
  const x=w1*x1+w2*x2,y=w1*y1+w2*y2,z=w1*z1+w2*z2
  return [Math.atan2(z,Math.sqrt(x*x+y*y))/r,Math.atan2(y,x)/r]
}

function brng(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r=Math.PI/180,dLon=(lon2-lon1)*r
  const y=Math.sin(dLon)*Math.cos(lat2*r)
  const x=Math.cos(lat1*r)*Math.sin(lat2*r)-Math.sin(lat1*r)*Math.cos(lat2*r)*Math.cos(dLon)
  return (Math.atan2(y,x)/r+360)%360
}

function interpolatePath(wps: Waypoint[], f: number): [number, number] {
  if (!wps.length) return [0,0]
  if (f<=wps[0].f) return [wps[0].lat,wps[0].lon]
  const last=wps[wps.length-1]
  if (f>=last.f) return [last.lat,last.lon]
  let lo=0,hi=wps.length-1
  while (hi-lo>1){const mid=(lo+hi)>>1;if(wps[mid].f<=f)lo=mid;else hi=mid}
  const a=wps[lo],b=wps[hi],t=(f-a.f)/(b.f-a.f)
  return [a.lat+t*(b.lat-a.lat),a.lon+t*(b.lon-a.lon)]
}

function bearingFromPath(wps: Waypoint[], f: number): number {
  const dt=0.01
  const [aLat,aLon]=interpolatePath(wps,Math.max(0,f-dt/2))
  const [bLat,bLon]=interpolatePath(wps,Math.min(1,f+dt/2))
  return brng(aLat,aLon,bLat,bLon)
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Aircraft = {
  hex: string; flight: string
  lat: number; lon: number
  track: number | null; true_heading: number | null; t: string | null
  board_match: boolean
  dep_iata: string | null; arr_iata: string | null
  iata_number: string | null; airline_iata: string | null
  actual_dep_utc: string | null; actual_arr_utc: string | null
  dep_time_utc: string | null; arr_time_utc: string | null; duration_min: number | null
  dep_delay_min: number | null
  alt_baro: number | 'ground' | null; gs: number | null
}

type BoardDeparted = {
  callsign: string; dep_iata: string; arr_iata: string
  duration_min: number
  actual_dep_utc: string | null; actual_arr_utc: string | null
  revised_arr_utc: string | null
  iata_number: string; airline_iata: string | null
  dep_delay_min: number | null
}

type DisplayItem = {
  key: string; callsign: string; label: string | null
  lat: number; lon: number; track: number
  dep_iata: string | null; arr_iata: string | null
  actual_dep_utc: string | null; actual_arr_utc: string | null
  revised_arr_utc: string | null
  dep_time_utc: string | null; arr_time_utc: string | null; duration_min: number | null
  dep_delay_min: number | null
  fraction: number | null
  t: string | null; alt_baro: number | 'ground' | null; gs: number | null
  airline_iata: string | null; iata_number: string | null
  isEstimated: boolean; isArrived: boolean; isAlp: boolean
}

function toFlight(item: DisplayItem): Flight {
  const icao = item.callsign.replace(/\d/g,'').slice(0,3).toUpperCase()
  const aIata = item.airline_iata ?? ICAO_TO_IATA[icao] ?? icao
  const status = item.isArrived ? 'Arrived'
    : item.isEstimated ? 'Departed'
    : 'En Route'
  const expectedArrISO = item.actual_dep_utc && item.duration_min
    ? new Date(new Date(item.actual_dep_utc).getTime() + item.duration_min * 60_000).toISOString()
    : null
  // Prefer the FR24-provided revised_arr_utc; fall back to computed from dep+duration if delayed
  const revisedArrUtc = !item.isArrived
    ? (item.revised_arr_utc ?? ((item.dep_delay_min ?? 0) > 0 ? expectedArrISO : null))
    : null
  return {
    iata_number:    item.iata_number ?? item.callsign,
    airline_name:   AIRLINE_NAME[aIata] ?? aIata,
    airline_iata:   aIata,
    country_flag:   '',
    dep_iata:       item.dep_iata ?? '',
    arr_iata:       item.arr_iata ?? '',
    dep_time_utc:   item.actual_dep_utc ?? item.dep_time_utc ?? '--:--',
    arr_time_utc:   item.arr_time_utc ?? expectedArrISO ?? item.actual_arr_utc ?? '--:--',
    sched_dep_unix: null,
    duration_min:   item.duration_min ?? 0,
    status,
    actual_dep_utc:  item.actual_dep_utc,
    actual_arr_utc:  item.actual_arr_utc,
    revised_dep_utc: null,
    revised_arr_utc: revisedArrUtc,
    aircraft_type:   item.t,
    dep_terminal: null, dep_gate: null,
    arr_terminal: null, arr_gate: null,
    arr_baggage:  null,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function MapTab() {
  const [items, setItems]       = useState<DisplayItem[]>([])
  const [selected, setSelected] = useState<DisplayItem | null>(null)
  const [loading, setLoading]   = useState(true)

  const routePathsRef = useRef<Record<string, Waypoint[]>>({})

  useEffect(() => {
    fetch(`${BASE}/api/routes`)
      .then(r => r.json())
      .then(d => {
        if (!d.ok) return
        const rec: Record<string, Waypoint[]> = {}
        for (const p of (d.paths as { dep_iata: string; arr_iata: string; waypoints: Waypoint[] }[])) {
          rec[`${p.dep_iata}|${p.arr_iata}`] = p.waypoints
        }
        routePathsRef.current = rec
      })
      .catch(() => {})
  }, [])

  const buildItems = useCallback((aircraft: Aircraft[], boardDeparted: BoardDeparted[]) => {
    const now = Date.now()
    const result: DisplayItem[] = []
    const covered = new Set<string>()

    for (const a of aircraft) {
      if (!a.board_match || !a.lat || !a.lon) continue
      const cs = (a.flight ?? '').trim()
      if (!cs) continue
      covered.add(cs)
      const isArrived = !!a.actual_arr_utc
      const isAlp = a.arr_iata === 'ALP' || a.dep_iata === 'ALP'
      // track fallback: ADS-B track → true_heading → route bearing dep→arr
      const depC = a.dep_iata ? AIRPORT[a.dep_iata] : null
      const arrC = a.arr_iata ? AIRPORT[a.arr_iata] : null
      const routeTrk = depC && arrC ? brng(depC[0], depC[1], arrC[0], arrC[1]) : 0
      const liveTrk = a.track ?? a.true_heading ?? routeTrk
      result.push({
        key:cs, callsign:cs, label:cs,
        lat:a.lat, lon:a.lon, track:liveTrk,
        dep_iata:a.dep_iata, arr_iata:a.arr_iata,
        actual_dep_utc:a.actual_dep_utc, actual_arr_utc:a.actual_arr_utc, revised_arr_utc:null,
        dep_time_utc:a.dep_time_utc??null, arr_time_utc:a.arr_time_utc, duration_min:a.duration_min??null,
        dep_delay_min:a.dep_delay_min??null, fraction:null,
        t:a.t, alt_baro:a.alt_baro, gs:a.gs,
        airline_iata:a.airline_iata, iata_number:a.iata_number,
        isEstimated:false, isArrived, isAlp,
      })
    }

    for (const bd of boardDeparted) {
      const {callsign:cs,dep_iata,arr_iata,duration_min,
             actual_dep_utc,actual_arr_utc,revised_arr_utc,iata_number,airline_iata,dep_delay_min} = bd
      if (!cs||covered.has(cs)||!dep_iata||!arr_iata) continue
      const depC=AIRPORT[dep_iata],arrC=AIRPORT[arr_iata]
      if (!depC||!arrC) continue
      const isArrived = !!actual_arr_utc
      let lat: number,lon: number,trk: number
      if (isArrived) {
        const sinceArrMin=(now-new Date(actual_arr_utc!).getTime())/60_000
        if (sinceArrMin>90) continue
        lat=arrC[0];lon=arrC[1];trk=brng(depC[0],depC[1],arrC[0],arrC[1])
      } else if (actual_dep_utc&&duration_min>0) {
        const elapsedMin=(now-new Date(actual_dep_utc).getTime())/60_000
        if (elapsedMin<0) continue
        const rawF=elapsedMin/duration_min
        if (rawF>1.5) continue
        const f=Math.min(rawF,0.97)
        const wps=routePathsRef.current[`${dep_iata}|${arr_iata}`]
        if (wps?.length){[lat,lon]=interpolatePath(wps,f);trk=bearingFromPath(wps,f)}
        else{[lat,lon]=slerpGreatCircle(depC[0],depC[1],arrC[0],arrC[1],f);trk=brng(depC[0],depC[1],arrC[0],arrC[1])}
      } else continue
      covered.add(cs)
      const bdFrac=(!isArrived&&actual_dep_utc&&duration_min>0)
        ?Math.min((now-new Date(actual_dep_utc).getTime())/60_000/duration_min,0.97):null
      const isAlp=arr_iata==='ALP'||dep_iata==='ALP'
      result.push({
        key:cs,callsign:cs,label:cs,
        lat,lon,track:trk,dep_iata,arr_iata,
        actual_dep_utc,actual_arr_utc,revised_arr_utc:revised_arr_utc??null,
        dep_time_utc:null,
        arr_time_utc:actual_dep_utc&&duration_min>0?new Date(new Date(actual_dep_utc).getTime()+duration_min*60_000).toISOString():null,
        duration_min,dep_delay_min:dep_delay_min??null,fraction:bdFrac,
        t:null,alt_baro:null,gs:null,
        airline_iata,iata_number,
        isEstimated:true,isArrived,isAlp,
      })
    }

    setItems(result)
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/airspace`)
      const json = await res.json()
      buildItems(json.aircraft??[], json.boardDeparted??[])
    } catch {}
    setLoading(false)
  }, [buildItems])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const cardView = selected?.dep_iata && SYRIA.has(selected.dep_iata) ? 'dep' : 'arr'

  return (
    <View style={{ flex: 1 }}>
      <MapView
        style={{ flex: 1 }}
        provider={PROVIDER_DEFAULT}
        mapType="satellite"
        initialRegion={{ latitude: 33, longitude: 40, latitudeDelta: 20, longitudeDelta: 30 }}
        showsPointsOfInterest={false}
        showsBuildings={false}
        showsCompass={false}
        showsScale={false}
        showsTraffic={false}
        onPress={() => setSelected(null)}
      >
        <UrlTile
          urlTemplate="https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png"
          maximumZ={19}
          flipY={false}
          zIndex={0}
        />
        {SERVICED.map((c, i) => (
          <Marker
            key={`apt-${i}`}
            coordinate={c}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
            onPress={e => e.stopPropagation()}
          >
            <Text style={styles.airportLabel}>{c.iata}</Text>
          </Marker>
        ))}
        {items.map(item => {
          const isSelected = selected?.key === item.key
          const color = isSelected ? '#38bdf8'
            : item.isAlp     ? '#f97316'
            : item.isArrived ? '#9ca3af'
            : '#16a34a'

          return (
            <Marker
              key={item.key}
              coordinate={{ latitude: item.lat, longitude: item.lon }}
              onPress={e => { e.stopPropagation(); setSelected(item) }}
              anchor={{ x: 0.5, y: 0.5 }}
              tracksViewChanges={false}
            >
              <View style={styles.markerWrap}>
                <Text style={{
                  fontSize: 22,
                  color,
                  opacity: item.isArrived ? 0.35 : item.isEstimated ? 0.65 : 1,
                  transform: [{ rotate: `${item.track - 90}deg` }],
                }}>✈</Text>
                <View style={styles.labelWrap}>
                  <Text style={[styles.labelText, {
                    color: item.isAlp      ? '#f97316'
                         : item.isArrived  ? '#4b5563'
                         : item.isEstimated ? '#fbbf24'
                         : '#4ade80',
                  }]}>{item.callsign}</Text>
                  {item.isArrived && (
                    <Text style={styles.arrivedText}>ARRIVED</Text>
                  )}
                </View>
              </View>
            </Marker>
          )
        })}
      </MapView>

      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color="#16a34a" />
        </View>
      )}

      <View style={styles.badge}>
        <Text style={styles.badgeText}>{items.filter(i => !i.isArrived).length} in Air</Text>
      </View>

      {/* Flight card popup */}
      {selected && (
        <View style={styles.cardWrap}>
          <TouchableOpacity style={styles.closeBtn} onPress={() => setSelected(null)}>
            <Text style={styles.closeText}>Close</Text>
          </TouchableOpacity>
          <FlightCard f={toFlight(selected)} view={cardView} hideBadge />
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  airportLabel: {
    color: 'rgba(229,62,62,0.7)',
    fontSize: 9,
    fontWeight: '600',
    fontFamily: 'monospace',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  markerWrap:  { alignItems: 'center' },
  labelWrap:   { alignItems: 'center', marginTop: 2 },
  labelText: {
    fontSize: 10, fontWeight: '700', fontFamily: 'monospace',
    textShadowColor: 'rgba(0,0,0,0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  arrivedText: {
    color: '#4b5563', fontSize: 8, fontWeight: '700', fontFamily: 'monospace',
    textShadowColor: 'rgba(0,0,0,0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center' },
  badge: {
    position: 'absolute', top: 56, right: 12,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5,
    borderWidth: 1, borderColor: '#374151',
  },
  badgeText:  { color: '#d1d5db', fontSize: 11, fontWeight: '600' },
  cardWrap: {
    position: 'absolute', bottom: 16, left: 12, right: 12,
  },
  closeBtn: {
    position: 'absolute', top: 8, right: 8, zIndex: 10,
    backgroundColor: '#374151', borderRadius: 99,
    paddingHorizontal: 12, paddingVertical: 5,
  },
  closeText: { color: '#d1d5db', fontSize: 13, fontWeight: '600' },
})

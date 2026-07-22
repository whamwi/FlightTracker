'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import Link from 'next/link'

// ── Airport city names ───────────────────────────────────────────────────────
const CITY: Record<string, string> = {
  DAM: 'Damascus',    ALP: 'Aleppo',       DXB: 'Dubai',
  SHJ: 'Sharjah',    AUH: 'Abu Dhabi',    MCT: 'Muscat',
  IST: 'Istanbul',   SAW: 'Istanbul',     AMM: 'Amman',
  BEY: 'Beirut',     CAI: 'Cairo',        DOH: 'Doha',
  KWI: 'Kuwait City',RUH: 'Riyadh',       JED: 'Jeddah',
  DMM: 'Dammam',     OTP: 'Bucharest',    EVN: 'Yerevan',
  GYD: 'Baku',       TBS: 'Tbilisi',      BGW: 'Baghdad',
  EBL: 'Erbil',      NJF: 'Najaf',        ESB: 'Ankara',
  SKD: 'Samarkand',  TAS: 'Tashkent',     AMS: 'Amsterdam',
  MJI: 'Tripoli',
}
const cityName = (iata: string) => CITY[iata] ?? iata

// ── Destination country flags ─────────────────────────────────────────────────
const AIRPORT_FLAG: Record<string, string> = {
  DAM: '🇸🇾', ALP: '🇸🇾',
  DXB: '🇦🇪', SHJ: '🇦🇪', AUH: '🇦🇪', MCT: '🇴🇲',
  IST: '🇹🇷', SAW: '🇹🇷', ESB: '🇹🇷',
  AMM: '🇯🇴', BEY: '🇱🇧', CAI: '🇪🇬',
  DOH: '🇶🇦', KWI: '🇰🇼', RUH: '🇸🇦', JED: '🇸🇦', DMM: '🇸🇦',
  OTP: '🇷🇴', EVN: '🇦🇲', GYD: '🇦🇿', TBS: '🇬🇪',
  BGW: '🇮🇶', EBL: '🇮🇶', NJF: '🇮🇶',
  SKD: '🇺🇿', TAS: '🇺🇿',
  AMS: '🇳🇱', MJI: '🇱🇾',
}

// ── Day display: Sun-first order matching airport FIDS convention ─────────────
const DOW_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const DOW_LABEL: Record<string, string> = {
  sun: 'S', mon: 'M', tue: 'T', wed: 'W', thu: 'T', fri: 'F', sat: 'S',
}
const DOW_FULL: Record<string, string> = {
  sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat',
}

function sortDays(days: string[]): string[] {
  return [...days].sort((a, b) => DOW_ORDER.indexOf(a as typeof DOW_ORDER[number]) - DOW_ORDER.indexOf(b as typeof DOW_ORDER[number]))
}

function fmtDur(min: number) {
  if (!min) return ''
  const h = Math.floor(min / 60)
  const m = min % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

// ── Types ────────────────────────────────────────────────────────────────────
interface ScheduleRow {
  id: number
  dep_iata: string
  arr_iata: string
  dep_time: string
  arr_time: string
  duration_min: number
  days_of_week: string[]
  iata_number: string
  broadcast_callsign: string
  airline_name: string
  country_flag: string
  codeshare_iata: string | null
}

interface AirlineEntry {
  flag: string
  name: string
  prefix: string
}

interface Destination {
  iata: string
  allDays: string[]
  airlines: AirlineEntry[]
  flights: ScheduleRow[]
  minDuration: number
}

// ── Day bubbles ───────────────────────────────────────────────────────────────
function DayBubbles({ days, size = 'md' }: { days: string[]; size?: 'sm' | 'md' }) {
  const cls = size === 'md'
    ? 'w-7 h-7 text-[11px]'
    : 'w-6 h-6 text-[10px]'
  return (
    <div className="flex gap-0.5">
      {DOW_ORDER.map(d => (
        <span
          key={d}
          title={DOW_FULL[d]}
          className={`${cls} rounded-full font-bold flex items-center justify-center leading-none select-none
            ${days.includes(d) ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-600'}`}
        >
          {DOW_LABEL[d]}
        </span>
      ))}
    </div>
  )
}

// ── Airline logo — local override → FlightsFrom CDN → emoji flag ─────────────
const LOCAL_LOGOS: Record<string, string> = {
  XH: '/airlines/XH.jpg',
  EY: '/airlines/EY.png',
}

function AirlineLogo({ prefix, flag, name, size = 28 }: { prefix: string; flag: string; name: string; size?: number }) {
  const [src, setSrc] = useState(LOCAL_LOGOS[prefix] ?? `https://images.flightsfrom.com/airlines/100/${prefix}_100px.png`)
  const [failed, setFailed] = useState(false)

  const handleError = () => {
    if (LOCAL_LOGOS[prefix] && src === LOCAL_LOGOS[prefix]) {
      setSrc(`https://images.flightsfrom.com/airlines/100/${prefix}_100px.png`)
    } else {
      setFailed(true)
    }
  }

  if (failed) {
    return <span className="text-lg leading-none" title={name}>{flag}</span>
  }
  return (
    <img
      src={src}
      alt={name}
      title={name}
      width={size}
      height={size}
      className="rounded-lg object-cover"
      onError={handleError}
    />
  )
}

function AirlineLogos({ airlines }: { airlines: AirlineEntry[] }) {
  const MAX = 3
  const shown = airlines.slice(0, MAX)
  const extra = airlines.length - MAX
  return (
    <div className="flex items-center gap-1">
      {shown.map(a => (
        <AirlineLogo key={a.prefix} prefix={a.prefix} flag={a.flag} name={a.name} />
      ))}
      {extra > 0 && (
        <span className="text-xs text-gray-500 font-medium">+{extra}</span>
      )}
    </div>
  )
}

// ── Destination card ──────────────────────────────────────────────────────────
function DestCard({ dest, onClick }: { dest: Destination; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left border-b border-gray-800/60 px-4 py-4 active:bg-gray-800/40 transition-colors"
    >
      {/* Row 1: city + IATA + airline flags */}
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="flex items-baseline gap-2 min-w-0">
          {AIRPORT_FLAG[dest.iata] && (
            <span className="text-base leading-none shrink-0">{AIRPORT_FLAG[dest.iata]}</span>
          )}
          <span className="text-white font-semibold text-base leading-tight truncate">
            {cityName(dest.iata)}
          </span>
          <span className="text-gray-500 font-mono text-sm shrink-0">{dest.iata}</span>
        </div>
        <AirlineLogos airlines={dest.airlines} />
      </div>

      {/* Row 2: day bubbles + duration */}
      <div className="flex items-center justify-between gap-3">
        <DayBubbles days={dest.allDays} size="md" />
        {dest.minDuration > 0 && (
          <span className="text-gray-400 text-sm font-medium shrink-0">{fmtDur(dest.minDuration)}</span>
        )}
      </div>
    </button>
  )
}

// ── Flight row (inside bottom sheet) ─────────────────────────────────────────
function FlightRow({ f }: { f: ScheduleRow }) {
  return (
    <div className="px-4 py-3.5 border-b border-gray-800/60">
      {/* Airline + flight number */}
      <div className="flex items-center gap-2 mb-3">
        <AirlineLogo prefix={f.iata_number.slice(0, 2)} flag={f.country_flag} name={f.airline_name} size={32} />
        <span className="text-white font-medium text-sm">{f.airline_name}</span>
        <span className="text-gray-400 font-mono text-xs ml-auto">{f.iata_number}</span>
      </div>
      {/* Times with duration centred on the arrow */}
      <div className="flex items-center gap-3 mb-3">
        <span className="font-mono text-white font-semibold text-lg">{f.dep_time}</span>
        <div className="flex-1 flex flex-col items-center gap-0.5">
          <div className="flex items-center gap-1 w-full">
            <div className="h-px flex-1 bg-gray-700" />
            <span className="text-gray-600 text-xs">✈</span>
            <div className="h-px flex-1 bg-gray-700" />
          </div>
          {f.duration_min > 0 && (
            <span className="text-gray-400 text-xs font-medium">{fmtDur(f.duration_min)}</span>
          )}
        </div>
        <span className="font-mono text-white font-semibold text-lg">{f.arr_time}</span>
      </div>
      {/* Days */}
      <DayBubbles days={f.days_of_week} size="sm" />
    </div>
  )
}

// ── Bottom sheet ──────────────────────────────────────────────────────────────
function BottomSheet({ dest, onClose }: {
  dest: Destination | null
  onClose: () => void
}) {
  // Prevent body scroll when open
  useEffect(() => {
    if (dest) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
    return () => { document.body.style.overflow = '' }
  }, [dest])

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/60 transition-opacity duration-300
          ${dest ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
      />

      {/* Sheet */}
      <div
        className={`fixed bottom-0 left-0 right-0 z-50 bg-gray-900 rounded-t-2xl
          max-h-[82vh] flex flex-col
          transition-transform duration-300 ease-out
          ${dest ? 'translate-y-0' : 'translate-y-full'}`}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-gray-700" />
        </div>

        {dest && (
          <>
            {/* Sheet header */}
            <div className="px-4 pt-2 pb-3 border-b border-gray-800 shrink-0">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-white font-bold text-lg leading-tight">
                    {cityName(dest.iata)}
                    <span className="text-gray-500 font-mono font-normal text-base ml-2">{dest.iata}</span>
                  </p>
                  <p className="text-gray-500 text-xs mt-0.5">
                    {dest.flights.length} {dest.flights.length === 1 ? 'flight' : 'flights'}
                    {dest.minDuration > 0 && ` · ${fmtDur(dest.minDuration)}`}
                  </p>
                </div>
                <button
                  onClick={onClose}
                  className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-gray-400 hover:text-white text-lg leading-none"
                >
                  ×
                </button>
              </div>
            </div>

            {/* Flight list */}
            <div className="overflow-y-auto flex-1">
              {dest.flights.map(f => <FlightRow key={f.id} f={f} />)}
              <div className="h-8" />
            </div>
          </>
        )}
      </div>
    </>
  )
}

// ── Toggle button ─────────────────────────────────────────────────────────────
function Toggle<T extends string>({
  options, value, onChange,
}: { options: { val: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex bg-gray-800 rounded-xl p-1 gap-1">
      {options.map(o => (
        <button
          key={o.val}
          onClick={() => onChange(o.val)}
          className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors
            ${value === o.val ? 'bg-white text-gray-900' : 'text-gray-400 hover:text-white'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DestinationsPage() {
  const [rows, setRows]     = useState<ScheduleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [airport, setAirport] = useState<'DAM' | 'ALP'>('DAM')
  const [selected, setSelected] = useState<Destination | null>(null)

  useEffect(() => {
    fetch('/api/schedule')
      .then(r => r.json())
      .then(d => { if (d.ok) setRows(d.rows) })
      .finally(() => setLoading(false))
  }, [])

  const destinations = useMemo((): Destination[] => {
    const relevant = rows.filter(r => r.dep_iata === airport)
    const grouped = new Map<string, ScheduleRow[]>()
    for (const r of relevant) {
      const key = r.arr_iata
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(r)
    }
    return Array.from(grouped.entries())
      .map(([iata, flights]) => {
        const allDays = sortDays([...new Set(flights.flatMap(f => f.days_of_week))])
        const seen = new Set<string>()
        const airlines: AirlineEntry[] = []
        for (const f of flights) {
          const prefix = f.iata_number.slice(0, 2)
          if (!seen.has(prefix)) {
            seen.add(prefix)
            airlines.push({ flag: f.country_flag, name: f.airline_name, prefix })
          }
        }
        const durations = flights.map(f => f.duration_min).filter(Boolean)
        const minDuration = durations.length ? Math.min(...durations) : 0
        const sorted = [...flights].sort((a, b) => a.dep_time.localeCompare(b.dep_time))
        return { iata, allDays, airlines, flights: sorted, minDuration }
      })
      .sort((a, b) => cityName(a.iata).localeCompare(cityName(b.iata)))
  }, [rows, airport])

  const handleClose = useCallback(() => setSelected(null), [])

  const airportLabel = { DAM: 'Damascus · DAM', ALP: 'Aleppo · ALP' }

  return (
    <div className="min-h-screen bg-gray-950 text-white">

      {/* ── Header ── */}
      <div className="sticky top-0 z-30 bg-gray-950/95 backdrop-blur border-b border-gray-800">
        <div className="max-w-2xl mx-auto px-4 pt-4 pb-3 space-y-3">
          <div className="flex items-center justify-between">
            <Link href="/" className="text-gray-400 hover:text-white text-sm transition-colors">
              ← Map
            </Link>
            <h1 className="font-bold text-base">{airportLabel[airport]}</h1>
            <Link href="/board" className="text-gray-400 hover:text-white text-sm transition-colors">
              Board →
            </Link>
          </div>

          {/* Airport toggle */}
          <Toggle
            options={[
              { val: 'DAM', label: 'Damascus' },
              { val: 'ALP', label: 'Aleppo' },
            ]}
            value={airport}
            onChange={v => setAirport(v)}
          />

        </div>
      </div>

      {/* ── Body ── */}
      <div className="max-w-2xl mx-auto">

        {/* Count strip */}
        {!loading && (
          <p className="px-4 py-3 text-xs text-gray-500">
            {destinations.length === 0
              ? 'No routes found'
              : `${destinations.length} destination${destinations.length === 1 ? '' : 's'} from ${airport}`}
          </p>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <div className="w-7 h-7 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-500 text-sm">Loading routes…</p>
          </div>
        )}

        {/* Destination list */}
        {!loading && destinations.map(d => (
          <DestCard key={d.iata} dest={d} onClick={() => setSelected(d)} />
        ))}

        {/* Empty */}
        {!loading && destinations.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-2 text-center px-6">
            <span className="text-4xl">✈</span>
            <p className="text-gray-400 font-medium">No routes found</p>
            <p className="text-gray-600 text-sm">Try switching airport or direction</p>
          </div>
        )}

        <div className="h-16" />
      </div>

      {/* ── Bottom sheet ── */}
      <BottomSheet dest={selected} onClose={handleClose} />
    </div>
  )
}

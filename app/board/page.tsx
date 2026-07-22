'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

// ── Airport display names ────────────────────────────────────────────────────
const CITY: Record<string, string> = {
  DAM: 'Damascus',       ALP: 'Aleppo',          SHJ: 'Sharjah',
  DXB: 'Dubai',          AUH: 'Abu Dhabi',        MCT: 'Muscat',
  IST: 'Istanbul',       SAW: 'Istanbul (SAW)',   AMM: 'Amman',
  BEY: 'Beirut',         CAI: 'Cairo',            DOH: 'Doha',
  KWI: 'Kuwait City',    RUH: 'Riyadh',           JED: 'Jeddah',
  DMM: 'Dammam',         BUH: 'Bucharest',        GYD: 'Baku',
  LED: 'St. Petersburg', SVO: 'Moscow',           KJA: 'Krasnoyarsk',
  IKT: 'Irkutsk',        TAS: 'Tashkent',         ALA: 'Almaty',
  DEL: 'Delhi',          BOM: 'Mumbai',           BGW: 'Baghdad',
  ESB: 'Ankara',         SKD: 'Samarkand',        NJF: 'Najaf',
  OTP: 'Bucharest',      EBL: 'Erbil',            MJI: 'Tripoli',
  AMS: 'Amsterdam',
}
const city = (iata: string) => CITY[iata] ?? iata

// ── Status badge config ──────────────────────────────────────────────────────
const STATUS: Record<string, { label: string; cls: string }> = {
  Scheduled:   { label: 'Scheduled',   cls: 'bg-gray-800 text-gray-400' },
  Expected:    { label: 'Expected',    cls: 'bg-blue-950 text-blue-300' },
  CheckIn:     { label: 'Check-in',    cls: 'bg-amber-950 text-amber-300' },
  Boarding:    { label: 'Boarding',    cls: 'bg-amber-900 text-amber-200' },
  GateClosed:  { label: 'Gate Closed', cls: 'bg-orange-950 text-orange-300' },
  Departed:    { label: 'Departed',    cls: 'bg-sky-900 text-sky-200' },
  'En Route':  { label: 'En Route',    cls: 'bg-sky-900 text-sky-200' },
  Approaching: { label: 'Approaching', cls: 'bg-teal-900 text-teal-200' },
  Arrived:     { label: 'Arrived',     cls: 'bg-green-950 text-green-300' },
  Landed:      { label: 'Arrived',     cls: 'bg-green-950 text-green-300' },
  Cancelled:   { label: 'Cancelled',   cls: 'bg-red-950 text-red-400' },
  Diverted:    { label: 'Diverted',    cls: 'bg-orange-900 text-orange-300' },
  Delayed:     { label: 'Delayed',     cls: 'bg-red-900 text-red-300' },
  Unknown:     { label: 'Unknown',     cls: 'bg-gray-800 text-gray-500' },
}

const STATUS_ALIAS: Record<string, string> = {
  Landed: 'Arrived',
  Land:   'Arrived',
}

// ── Local airline logo overrides ─────────────────────────────────────────────
const LOCAL_LOGOS: Record<string, string> = {
  XH: '/airlines/XH.jpg',
  EY: '/airlines/EY.png',
}

// ── Types ────────────────────────────────────────────────────────────────────
type Flight = {
  callsign: string
  iata_number: string
  airline_name: string
  airline_iata: string
  country_flag: string
  dep_iata: string
  arr_iata: string
  dep_time: string
  arr_time: string
  dep_time_utc: string
  arr_time_utc: string
  duration_min: number
  codeshare_iata: string | null
  status: string
  actual_dep_utc: string | null
  actual_arr_utc: string | null
  revised_dep_utc: string | null
  revised_arr_utc: string | null
  dep_delay_min: number | null
  arr_delay_min: number | null
  dep_terminal: string | null
  dep_gate: string | null
  dep_check_in_desk: string | null
  arr_terminal: string | null
  arr_gate: string | null
  arr_baggage_belt: string | null
  aircraft_type: string | null
  aircraft_reg: string | null
}

type Tab     = -1 | 0 | 1        // yesterday / today / tomorrow
type View    = 'arr' | 'dep'
type Airport = 'DAM' | 'ALP'
type Filter  = 'next' | 'all'

// ── Helpers ──────────────────────────────────────────────────────────────────

function syriaDate(offsetDays: number): string {
  const ms = Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

function fmtLocal(raw: string | null | undefined): string {
  if (!raw) return '—'
  if (raw.includes('T')) {
    const d = new Date(new Date(raw).getTime() + 3 * 3_600_000)
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  }
  return raw.slice(0, 5)
}

// Convert a stored UTC HH:MM time to Syria local (UTC+3)
function utcToSyria(hhmm: string | null | undefined): string {
  if (!hhmm) return '—'
  const [h, m] = hhmm.slice(0, 5).split(':').map(Number)
  const total = (h * 60 + m + 180) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function durationLabel(min: number): string {
  if (!min) return ''
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

function effectiveStatus(f: Flight): string {
  const s = STATUS_ALIAS[f.status] ?? f.status
  if (s !== 'Unknown') return s
  if (f.actual_arr_utc) return 'Arrived'
  if (f.actual_dep_utc) return 'Departed'
  return 'Unknown'
}

function calcDelay(schedHHMM: string, actualISO: string | null): number | null {
  if (!actualISO || !schedHHMM) return null
  const opDate = actualISO.slice(0, 10)
  return Math.round((new Date(actualISO).getTime() - new Date(`${opDate}T${schedHHMM}:00Z`).getTime()) / 60_000)
}

// "Next" = not in terminal state OR recently departed/arrived (within 60 min)
const TERMINAL = new Set(['Arrived', 'Landed', 'Cancelled', 'Diverted', 'Departed'])

function isNext(f: Flight, view: View): boolean {
  const s = effectiveStatus(f)
  if (!TERMINAL.has(s)) return true
  const ts = view === 'arr' ? f.actual_arr_utc : f.actual_dep_utc
  if (ts) return Date.now() - new Date(ts).getTime() <= 60 * 60_000
  return false
}

// ── Airline logo with CDN + local fallback ───────────────────────────────────
function AirlineLogo({ iata, flag, name }: { iata: string; flag: string; name: string }) {
  const [src, setSrc] = useState<string>(
    LOCAL_LOGOS[iata] ?? (iata ? `https://images.flightsfrom.com/airlines/100/${iata}_100px.png` : '')
  )
  const [failed, setFailed] = useState(!iata)

  const handleError = () => {
    if (LOCAL_LOGOS[iata] && src === LOCAL_LOGOS[iata]) {
      setSrc(`https://images.flightsfrom.com/airlines/100/${iata}_100px.png`)
    } else {
      setFailed(true)
    }
  }

  if (failed || !src) {
    return <span className="text-xl leading-none" title={name}>{flag}</span>
  }
  return (
    <img
      src={src}
      alt={name}
      title={name}
      width={32}
      height={32}
      className="rounded-lg object-cover shrink-0"
      onError={handleError}
    />
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS[status] ?? STATUS.Unknown
  return (
    <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full ${cfg.cls}`}>
      {cfg.label}
    </span>
  )
}

function DelayBadge({ min }: { min: number | null }) {
  if (min == null || Math.abs(min) < 1) return null
  return (
    <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${min > 0 ? 'bg-red-900 text-red-300' : 'bg-green-900 text-green-300'}`}>
      {min > 0 ? `+${min}m` : `${min}m`}
    </span>
  )
}

function FlightCard({ f, view }: { f: Flight; view: View }) {
  const isArr = view === 'arr'
  const status = effectiveStatus(f)
  const isCancelled = status === 'Cancelled'

  const depDelay = calcDelay(f.dep_time_utc, f.actual_dep_utc ?? f.revised_dep_utc)
  const arrDelay = calcDelay(f.arr_time_utc, f.actual_arr_utc ?? f.revised_arr_utc)

  return (
    <div className={`bg-gray-900 border rounded-xl p-4 flex flex-col gap-3 ${isCancelled ? 'border-red-900/60 opacity-60' : 'border-gray-800'}`}>

      {/* Row 1: Airline logo + name + status */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <AirlineLogo iata={f.airline_iata} flag={f.country_flag} name={f.airline_name} />
          <div className="min-w-0">
            <p className="text-white font-semibold text-sm leading-tight truncate">{f.airline_name}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-gray-300 text-xs font-mono font-medium">{f.iata_number}</span>
              <span className="text-gray-600 text-xs font-mono">{f.callsign}</span>
            </div>
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Row 2: Route */}
      <div className="flex items-center gap-2">
        <div className="text-center min-w-[3.5rem]">
          <p className="text-white font-bold text-lg leading-tight">{f.dep_iata}</p>
          <p className="text-gray-400 text-xs truncate">{city(f.dep_iata)}</p>
        </div>
        <div className="flex-1 flex flex-col items-center gap-0.5">
          <div className="flex items-center gap-1 w-full">
            <div className="flex-1 h-px bg-gray-700" />
            <span className="text-gray-600 text-xs">✈</span>
            <div className="flex-1 h-px bg-gray-700" />
          </div>
          {f.duration_min > 0 && (
            <p className="text-gray-600 text-xs">{durationLabel(f.duration_min)}</p>
          )}
        </div>
        <div className="text-center min-w-[3.5rem]">
          <p className="text-white font-bold text-lg leading-tight">{f.arr_iata}</p>
          <p className="text-gray-400 text-xs truncate">{city(f.arr_iata)}</p>
        </div>
      </div>

      {/* Row 3: Times + details */}
      <div className="flex items-start justify-between gap-2">

        <div className="min-w-[3.5rem]">
          <p className="text-gray-500 text-xs mb-0.5">Dep</p>
          <p className={`font-mono font-semibold text-base ${isCancelled ? 'line-through text-gray-600' : 'text-white'}`}>
            {fmtLocal(f.dep_time)}
          </p>
          {(f.actual_dep_utc || f.revised_dep_utc) && !isCancelled && (
            <p className={`font-mono text-xs mt-0.5 ${f.actual_dep_utc ? 'text-green-400' : 'text-yellow-400'}`}>
              {fmtLocal(f.actual_dep_utc ?? f.revised_dep_utc ?? null)}
            </p>
          )}
          {!isArr && <DelayBadge min={depDelay} />}
          {f.dep_check_in_desk && (
            <p className="text-gray-400 text-xs mt-1">CK <span className="text-white font-medium">{f.dep_check_in_desk}</span></p>
          )}
          {!isArr && f.dep_gate && (
            <p className="text-gray-400 text-xs">Gate <span className="text-white font-medium">{f.dep_gate}</span></p>
          )}
          {!isArr && f.dep_terminal && (
            <p className="text-gray-400 text-xs">T<span className="text-white font-medium">{f.dep_terminal}</span></p>
          )}
        </div>

        <div className="flex-1 flex items-start justify-center pt-4">
          {f.aircraft_type && <p className="text-gray-600 text-xs">{f.aircraft_type}</p>}
        </div>

        <div className="min-w-[3.5rem] text-right">
          <p className="text-gray-500 text-xs mb-0.5">Arr</p>
          <p className={`font-mono font-semibold text-base ${isCancelled ? 'line-through text-gray-600' : 'text-white'}`}>
            {fmtLocal(f.arr_time)}
          </p>
          {(f.actual_arr_utc || f.revised_arr_utc) && !isCancelled && (
            <p className={`font-mono text-xs mt-0.5 ${f.actual_arr_utc ? 'text-green-400' : 'text-yellow-400'}`}>
              {fmtLocal(f.actual_arr_utc ?? f.revised_arr_utc ?? null)}
            </p>
          )}
          {isArr && <DelayBadge min={arrDelay} />}
          {isArr && f.arr_gate && (
            <p className="text-gray-400 text-xs mt-1">Gate <span className="text-white font-medium">{f.arr_gate}</span></p>
          )}
          {isArr && f.arr_terminal && (
            <p className="text-gray-400 text-xs">T<span className="text-white font-medium">{f.arr_terminal}</span></p>
          )}
          {isArr && f.arr_baggage_belt && (
            <p className="text-gray-400 text-xs">Belt <span className="text-white font-medium">{f.arr_baggage_belt}</span></p>
          )}
        </div>
      </div>

    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

const TAB_LABELS: Record<Tab, string> = { [-1]: 'Yesterday', 0: 'Today', 1: 'Tomorrow' }

export default function BoardPage() {
  const [tab, setTab]         = useState<Tab>(0)
  const [view, setView]       = useState<View>('arr')
  const [airport, setAirport] = useState<Airport>('DAM')
  const [filter, setFilter]   = useState<Filter>('next')
  const [flights, setFlights]         = useState<Flight[]>([])
  const [prevFlights, setPrevFlights] = useState<Flight[]>([])
  const [loading, setLoading]         = useState(true)
  const [date, setDate]               = useState('')

  const load = useCallback(async (offsetDays: number, silent = false) => {
    if (!silent) setLoading(true)
    const d = syriaDate(offsetDays)
    setDate(d)
    try {
      const res = await fetch(`/api/flightboard?date=${d}`)
      const json = await res.json()
      setFlights(json.flights ?? [])
    } catch {
      if (!silent) setFlights([])
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  const loadPrev = useCallback(async (offsetDays: number) => {
    const dPrev = syriaDate(offsetDays - 1)
    try {
      const res = await fetch(`/api/flightboard?date=${dPrev}`)
      const json = await res.json()
      setPrevFlights(json.flights ?? [])
    } catch {
      setPrevFlights([])
    }
  }, [])

  useEffect(() => { load(tab); loadPrev(tab) }, [tab, load, loadPrev])
  useEffect(() => {
    if (tab !== 0) return
    const t = setInterval(() => load(0, true), 60_000)
    return () => clearInterval(t)
  }, [tab, load])

  // Flights that cross midnight: arrive after midnight relative to departure (arr_time < dep_time)
  const crossesMidnight = (f: Flight) => f.arr_time < f.dep_time

  const byViewAndAirport = (() => {
    if (view === 'dep') {
      return flights.filter(f => f.dep_iata === airport)
    }
    // Arrivals: same-day (no midnight cross from current date) + overnight from prev day
    const sameDay   = flights.filter(f => f.arr_iata === airport && !crossesMidnight(f))
    const overnight = prevFlights.filter(f => f.arr_iata === airport && crossesMidnight(f))
    return [...sameDay, ...overnight]
  })()

  const sorted = [...byViewAndAirport].sort((a, b) => {
    const ta = view === 'arr' ? a.arr_time : a.dep_time
    const tb = view === 'arr' ? b.arr_time : b.dep_time
    return ta.localeCompare(tb)
  })

  const visible = filter === 'next' ? sorted.filter(f => isNext(f, view)) : sorted

  const total     = visible.length
  const landed    = visible.filter(f => ['Arrived', 'Landed'].includes(effectiveStatus(f))).length
  const cancelled = visible.filter(f => effectiveStatus(f) === 'Cancelled').length
  const enroute   = visible.filter(f => ['En Route', 'Departed', 'Approaching'].includes(effectiveStatus(f))).length

  const dateLabel = date
    ? new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long'
      })
    : ''

  return (
    <div className="min-h-screen bg-gray-950 text-white">

      {/* ── Header ── */}
      <div className="sticky top-0 z-20 bg-gray-950/95 backdrop-blur border-b border-gray-800">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-gray-400 hover:text-white text-sm transition-colors">
              ← Map
            </Link>
            <span className="text-gray-700">|</span>
            <h1 className="font-semibold text-base">Flight Board</h1>
          </div>
          <span className="text-gray-500 text-xs">{tab === 0 ? 'Auto-refresh 60s' : dateLabel}</span>
        </div>

        {/* ── Day tabs ── */}
        <div className="max-w-2xl mx-auto px-4 pb-3 flex gap-2">
          {([-1, 0, 1] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                tab === t ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {/* ── All 5 controls on one row ── */}
        <div className="max-w-2xl mx-auto px-4 pb-3">
          <div className="flex bg-gray-800 rounded-xl p-1 gap-1">
            <button
              onClick={() => setView('dep')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                view === 'dep' ? 'bg-white text-gray-900' : 'text-gray-400 hover:text-white'
              }`}
            >
              Departures
            </button>
            <button
              onClick={() => setView('arr')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                view === 'arr' ? 'bg-white text-gray-900' : 'text-gray-400 hover:text-white'
              }`}
            >
              Arrivals
            </button>
            <button
              onClick={() => setFilter(f => f === 'next' ? 'all' : 'next')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors border ${
                filter === 'next'
                  ? 'border-blue-500/60 text-blue-300 bg-blue-950/60'
                  : 'border-gray-600/60 text-gray-400 bg-gray-700/40'
              }`}
            >
              {filter === 'next' ? 'Next' : 'All'}
            </button>
            <div className="w-px bg-gray-700 my-1" />
            {(['DAM', 'ALP'] as Airport[]).map(ap => (
              <button
                key={ap}
                onClick={() => setAirport(ap)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  airport === ap ? 'bg-white text-gray-900' : 'text-gray-400 hover:text-white'
                }`}
              >
                {ap}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="max-w-2xl mx-auto px-4 py-4">

        {/* Summary strip */}
        {!loading && visible.length > 0 && (
          <div className="flex gap-4 text-xs text-gray-500 mb-4 px-1">
            <span>{total} flights</span>
            {enroute   > 0 && <span className="text-sky-400">{enroute} in air</span>}
            {landed    > 0 && <span className="text-green-400">{landed} arrived</span>}
            {cancelled > 0 && <span className="text-red-400">{cancelled} cancelled</span>}
            {tab !== 0 && <span className="ml-auto">{dateLabel}</span>}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-500 text-sm">Loading flights…</p>
          </div>
        )}

        {/* Empty */}
        {!loading && visible.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-2 text-center">
            <span className="text-4xl">✈</span>
            <p className="text-gray-400 font-medium">
              No {view === 'arr' ? 'arrivals' : 'departures'}
              {filter === 'next' ? ' coming up' : ''}
            </p>
            <p className="text-gray-600 text-sm">{airport} · {dateLabel}</p>
          </div>
        )}

        {/* Flight cards */}
        {!loading && (
          <div className="flex flex-col gap-3">
            {visible.map(f => (
              <FlightCard key={`${f.callsign}-${f.dep_iata}-${f.arr_iata}-${f.dep_time}`} f={f} view={view} />
            ))}
          </div>
        )}

        {tab === 1 && !loading && visible.length > 0 && (
          <p className="text-center text-gray-600 text-xs mt-6">
            Tomorrow's flights show scheduled times only · Live data arrives on the day
          </p>
        )}
      </div>
    </div>
  )
}

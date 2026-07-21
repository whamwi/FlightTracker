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
  Unknown:     { label: 'Unknown',     cls: 'bg-gray-800 text-gray-500' },
}

// Normalise string variants ADB sometimes sends before display-level inference
const STATUS_ALIAS: Record<string, string> = {
  Landed: 'Arrived',
  Land:   'Arrived',
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

type Tab = -1 | 0 | 1  // yesterday / today / tomorrow
type View = 'arr' | 'dep'
type Airport = 'ALL' | 'DAM' | 'ALP'

// ── Helpers ──────────────────────────────────────────────────────────────────

// Syria is UTC+3. Compute date string for offset days.
function syriaDate(offsetDays: number): string {
  const ms = Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

// Format "HH:MM" from ISO timestamp (UTC) or "HH:MM" time string
function fmtUTC(raw: string | null | undefined): string {
  if (!raw) return '—'
  if (raw.includes('T')) {
    const d = new Date(raw)
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  }
  return raw.slice(0, 5)
}

function durationLabel(min: number): string {
  if (!min) return ''
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

// ── Sub-components ───────────────────────────────────────────────────────────

// Infer a meaningful display status when ADB returns "Unknown" or unmapped strings
function effectiveStatus(f: Flight): string {
  const s = STATUS_ALIAS[f.status] ?? f.status
  if (s !== 'Unknown') return s
  if (f.actual_arr_utc) return 'Arrived'
  if (f.actual_dep_utc) return 'Departed'
  return 'Unknown'
}

// Recalculate delay from schedule HH:MM + operating date vs actual ISO timestamp.
// More reliable than stored arr_delay_min which may reference ADB's own scheduled time.
function calcDelay(schedHHMM: string, actualISO: string | null, date: string): number | null {
  if (!actualISO || !schedHHMM || !date) return null
  const diff = (new Date(actualISO).getTime() - new Date(`${date}T${schedHHMM}:00Z`).getTime()) / 60_000
  return Math.round(diff)
}

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

function FlightCard({ f, view, date }: { f: Flight; view: View; date: string }) {
  const isArr = view === 'arr'
  const schedTime   = isArr ? f.arr_time_utc  : f.dep_time_utc
  const actualTime  = isArr ? f.actual_arr_utc : f.actual_dep_utc
  const revisedTime = isArr ? f.revised_arr_utc : f.revised_dep_utc
  const delayMin    = calcDelay(schedTime, actualTime, date)
  const status      = effectiveStatus(f)

  // Best estimated time to show: actual → revised → scheduled
  const bestTime = actualTime ?? revisedTime

  const terminal   = isArr ? f.arr_terminal   : f.dep_terminal
  const gate       = isArr ? f.arr_gate       : f.dep_gate
  const baggage    = isArr ? f.arr_baggage_belt : null
  const checkin    = isArr ? null             : f.dep_check_in_desk

  const isCancelled = status === 'Cancelled'

  return (
    <div className={`bg-gray-900 border rounded-xl p-4 flex flex-col gap-3 ${isCancelled ? 'border-red-900/60 opacity-60' : 'border-gray-800'}`}>

      {/* Row 1: Airline + Flight number */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xl leading-none">{f.country_flag}</span>
          <div className="min-w-0">
            <p className="text-white font-semibold text-sm leading-tight truncate">{f.airline_name}</p>
            <p className="text-gray-500 text-xs">{f.iata_number} · {f.callsign}</p>
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Row 2: Route */}
      <div className="flex items-center gap-2">
        <div className="text-center min-w-[3rem]">
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
        <div className="text-center min-w-[3rem]">
          <p className="text-white font-bold text-lg leading-tight">{f.arr_iata}</p>
          <p className="text-gray-400 text-xs truncate">{city(f.arr_iata)}</p>
        </div>
      </div>

      {/* Row 3: Times + delay */}
      <div className="flex items-end justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <div>
            <p className="text-gray-500 text-xs mb-0.5">{isArr ? 'Arr (sched)' : 'Dep (sched)'}</p>
            <p className={`font-mono font-semibold text-base ${isCancelled ? 'line-through text-gray-600' : 'text-white'}`}>
              {fmtUTC(schedTime)}
            </p>
          </div>
          {bestTime && !isCancelled && (
            <div>
              <p className="text-gray-500 text-xs mb-0.5">{actualTime ? 'Actual' : 'Estimated'}</p>
              <p className={`font-mono font-semibold text-base ${status === 'Arrived' || status === 'Departed' ? 'text-green-400' : 'text-yellow-400'}`}>
                {fmtUTC(bestTime)}
              </p>
            </div>
          )}
          <DelayBadge min={delayMin} />
        </div>

        {/* Gate / terminal / extras */}
        <div className="text-right text-xs text-gray-400 space-y-0.5 shrink-0">
          {terminal && <p>Terminal <span className="text-white font-medium">{terminal}</span></p>}
          {gate     && <p>Gate <span className="text-white font-medium">{gate}</span></p>}
          {checkin  && <p>Check-in <span className="text-white font-medium">{checkin}</span></p>}
          {baggage  && <p>Belt <span className="text-white font-medium">{baggage}</span></p>}
          {f.aircraft_type && <p className="text-gray-600">{f.aircraft_type}</p>}
        </div>
      </div>

    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

const TAB_LABELS: Record<Tab, string> = { [-1]: 'Yesterday', 0: 'Today', 1: 'Tomorrow' }

export default function BoardPage() {
  const [tab, setTab]           = useState<Tab>(0)
  const [view, setView]         = useState<View>('arr')
  const [airport, setAirport]   = useState<Airport>('ALL')
  const [flights, setFlights]   = useState<Flight[]>([])
  const [loading, setLoading]   = useState(true)
  const [date, setDate]         = useState('')

  const load = useCallback(async (offsetDays: Tab) => {
    setLoading(true)
    const d = syriaDate(offsetDays)
    setDate(d)
    try {
      const res = await fetch(`/api/flightboard?date=${d}`)
      const json = await res.json()
      setFlights(json.flights ?? [])
    } catch {
      setFlights([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load + refresh today every 60s
  useEffect(() => { load(tab) }, [tab, load])
  useEffect(() => {
    if (tab !== 0) return
    const t = setInterval(() => load(0), 60_000)
    return () => clearInterval(t)
  }, [tab, load])

  // Filter flights by view (arrivals/departures) and airport
  const SYRIA = ['DAM', 'ALP']
  const visible = flights.filter(f => {
    if (view === 'arr') {
      if (!SYRIA.includes(f.arr_iata)) return false
      if (airport !== 'ALL' && f.arr_iata !== airport) return false
    } else {
      if (!SYRIA.includes(f.dep_iata)) return false
      if (airport !== 'ALL' && f.dep_iata !== airport) return false
    }
    return true
  })

  // Sort by relevant time
  const sorted = [...visible].sort((a, b) => {
    const ta = view === 'arr' ? a.arr_time_utc : a.dep_time_utc
    const tb = view === 'arr' ? b.arr_time_utc : b.dep_time_utc
    return ta.localeCompare(tb)
  })

  // Summary counts (use effective status for accuracy)
  const total     = sorted.length
  const landed    = sorted.filter(f => ['Arrived', 'Landed'].includes(effectiveStatus(f))).length
  const cancelled = sorted.filter(f => effectiveStatus(f) === 'Cancelled').length
  const enroute   = sorted.filter(f => ['En Route', 'Departed', 'Approaching'].includes(effectiveStatus(f))).length

  const dateLabel = new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long'
  })

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
                tab === t
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {/* ── ARR / DEP + airport filter ── */}
        <div className="max-w-2xl mx-auto px-4 pb-3 flex items-center gap-3">
          {/* ARR / DEP */}
          <div className="flex bg-gray-800 rounded-lg p-0.5 gap-0.5">
            {(['arr', 'dep'] as View[]).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-colors ${
                  view === v ? 'bg-white text-gray-900' : 'text-gray-400 hover:text-white'
                }`}
              >
                {v === 'arr' ? '▼ Arrivals' : '▲ Departures'}
              </button>
            ))}
          </div>

          {/* Airport filter */}
          <div className="flex bg-gray-800 rounded-lg p-0.5 gap-0.5 ml-auto">
            {(['ALL', 'DAM', 'ALP'] as Airport[]).map(ap => (
              <button
                key={ap}
                onClick={() => setAirport(ap)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
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
        {!loading && sorted.length > 0 && (
          <div className="flex gap-4 text-xs text-gray-500 mb-4 px-1">
            <span>{total} flights</span>
            {enroute  > 0 && <span className="text-sky-400">{enroute} in air</span>}
            {landed   > 0 && <span className="text-green-400">{landed} arrived</span>}
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
        {!loading && sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-2 text-center">
            <span className="text-4xl">✈</span>
            <p className="text-gray-400 font-medium">No {view === 'arr' ? 'arrivals' : 'departures'} found</p>
            <p className="text-gray-600 text-sm">
              {airport !== 'ALL' ? `for ${airport} on ${dateLabel}` : `on ${dateLabel}`}
            </p>
          </div>
        )}

        {/* Flight cards */}
        {!loading && (
          <div className="flex flex-col gap-3">
            {sorted.map(f => (
              <FlightCard key={`${f.callsign}-${f.dep_iata}-${f.arr_iata}`} f={f} view={view} date={date} />
            ))}
          </div>
        )}

        {tab === 1 && !loading && sorted.length > 0 && (
          <p className="text-center text-gray-600 text-xs mt-6">
            Tomorrow's flights show scheduled times only · Live data arrives on the day
          </p>
        )}
      </div>
    </div>
  )
}

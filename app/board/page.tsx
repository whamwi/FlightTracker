'use client'

import { useEffect, useState, useCallback, useRef, Fragment } from 'react'
import Link from 'next/link'
import { AIRLINE_LOGOS, LOGO_WHITE_BG } from '@/lib/airlines'

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
  AMS: 'Amsterdam',   MED: 'Medina',
}
const city = (iata: string) => CITY[iata] ?? iata

const AIRPORT_FLAG: Record<string, string> = {
  DAM: '🇸🇾', ALP: '🇸🇾',
  SHJ: '🇦🇪', DXB: '🇦🇪', AUH: '🇦🇪',
  MCT: '🇴🇲',
  IST: '🇹🇷', SAW: '🇹🇷', ESB: '🇹🇷',
  AMM: '🇯🇴',
  BEY: '🇱🇧',
  CAI: '🇪🇬',
  DOH: '🇶🇦',
  KWI: '🇰🇼',
  RUH: '🇸🇦', JED: '🇸🇦', DMM: '🇸🇦', MED: '🇸🇦',
  BGW: '🇮🇶', NJF: '🇮🇶', EBL: '🇮🇶',
  BUH: '🇷🇴', OTP: '🇷🇴',
  GYD: '🇦🇿',
  LED: '🇷🇺', SVO: '🇷🇺', KJA: '🇷🇺', IKT: '🇷🇺',
  TAS: '🇺🇿', SKD: '🇺🇿',
  ALA: '🇰🇿',
  DEL: '🇮🇳', BOM: '🇮🇳',
  MJI: '🇱🇾',
  AMS: '🇳🇱',
  EVN: '🇦🇲',
}
const airportFlag = (iata: string) => AIRPORT_FLAG[iata] ?? ''

// ── Status badge config ──────────────────────────────────────────────────────
const STATUS: Record<string, { label: string; cls: string; color: string }> = {
  Scheduled:   { label: 'Scheduled',   cls: 'bg-gray-800 text-gray-400',     color: '#374151' },
  Expected:    { label: 'Expected',    cls: 'bg-yellow-950 text-yellow-300', color: '#ca8a04' },
  CheckIn:     { label: 'Check-in',    cls: 'bg-amber-950 text-amber-300',   color: '#d97706' },
  Boarding:    { label: 'Boarding',    cls: 'bg-amber-900 text-amber-200',   color: '#f59e0b' },
  GateClosed:  { label: 'Gate Closed', cls: 'bg-orange-950 text-orange-300', color: '#ea580c' },
  Departed:    { label: 'Departed',    cls: 'bg-sky-900 text-sky-200',       color: '#0284c7' },
  'En Route':  { label: 'En Route',    cls: 'bg-sky-900 text-sky-200',       color: '#0284c7' },
  Approaching: { label: 'Approaching', cls: 'bg-teal-900 text-teal-200',     color: '#0d9488' },
  Arrived:     { label: 'Arrived',     cls: 'bg-green-950 text-green-300',   color: '#16a34a' },
  Landed:      { label: 'Arrived',     cls: 'bg-green-950 text-green-300',   color: '#16a34a' },
  Cancelled:   { label: 'Cancelled',   cls: 'bg-red-950 text-red-400',       color: '#dc2626' },
  Diverted:    { label: 'Diverted',    cls: 'bg-orange-900 text-orange-300', color: '#ea580c' },
  Delayed:     { label: 'Delayed',     cls: 'bg-red-900 text-red-300',       color: '#ef4444' },
  Unknown:     { label: 'Unknown',     cls: 'bg-gray-800 text-gray-500',     color: '#374151' },
}

const STATUS_ALIAS: Record<string, string> = {
  Landed: 'Arrived',
  Land:   'Arrived',
}

const LOCAL_LOGOS = AIRLINE_LOGOS

// ── Types ────────────────────────────────────────────────────────────────────
type Flight = {
  iata_number: string
  airline_name: string
  airline_iata: string
  country_flag: string
  dep_iata: string
  arr_iata: string
  dep_time_utc: string
  arr_time_utc: string
  sched_dep_unix: number | null
  duration_min: number
  status: string
  actual_dep_utc: string | null
  actual_arr_utc: string | null
  revised_dep_utc: string | null
  revised_arr_utc: string | null
  aircraft_type: string | null
  aircraft_reg: string | null
  dep_terminal: string | null
  dep_gate: string | null
  arr_terminal: string | null
  arr_gate: string | null
  arr_baggage: string | null
}

type Tab     = -1 | 0 | 1        // yesterday / today / tomorrow
type View    = 'arr' | 'dep'
type Airport = 'DAM' | 'ALP'

// ── Helpers ──────────────────────────────────────────────────────────────────

function syriaDate(offsetDays: number): string {
  const ms = Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

// ── Airport UTC offsets (default = 3 = UTC+3, Syria's timezone) ─────────────
const UTC_OFFSET: Record<string, number> = {
  IKT: 8,  KJA: 7,
  DEL: 5.5, BOM: 5.5,
  TAS: 5,  ALA: 5,  SKD: 5,
  SHJ: 4,  DXB: 4,  AUH: 4,  MCT: 4,  EVN: 4,  GYD: 4,
  AMS: 2,  MJI: 2,  TIP: 2,
}
function tzOffset(iata: string): number { return UTC_OFFSET[iata] ?? 3 }

function utcHHMMtoLocal(hhmm: string, offsetH: number): string {
  const [h, m] = hhmm.slice(0, 5).split(':').map(Number)
  const total = ((h * 60 + m + Math.round(offsetH * 60)) % 1440 + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

// Accepts either an ISO timestamp or a HH:MM UTC string
function fmtLocal(raw: string | null | undefined, offsetH: number): string {
  if (!raw) return '—'
  if (raw.includes('T')) {
    const ms = new Date(raw).getTime() + Math.round(offsetH * 3_600_000)
    const d = new Date(ms)
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  }
  return utcHHMMtoLocal(raw, offsetH)
}

function durationLabel(min: number): string {
  if (!min) return ''
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

function effectiveStatus(f: Flight): string {
  const s = STATUS_ALIAS[f.status] ?? f.status
  // actual_arr_utc is ground truth — if the plane landed, override Cancelled/Unknown
  if (f.actual_arr_utc) return 'Arrived'
  if (s === 'Arrived' || s === 'Landed' || s === 'Cancelled' || s === 'Diverted') return s
  // Departure happened — check if delayed vs schedule, or already landed
  if (f.actual_dep_utc) {
    const actMs = new Date(f.actual_dep_utc).getTime()
    // If dep + block time is > 15 min in the past, the flight has landed
    if (f.duration_min && actMs + f.duration_min * 60_000 < Date.now() - 15 * 60_000) return 'Arrived'
    const schedMs = new Date(`1970-01-01T${f.dep_time_utc}:00Z`).getTime()
    const actHHMM = f.actual_dep_utc.slice(11, 16)
    const actMin  = parseInt(actHHMM.slice(0, 2)) * 60 + parseInt(actHHMM.slice(3))
    const schMin  = schedMs / 60_000
    return s !== 'Unknown' ? s : 'Departed'
  }
  if (f.revised_arr_utc && (s === 'Scheduled' || s === 'Unknown')) return 'Expected'
  return s
}

// Compute estimated arrival from ATD + schedule block time (fallback when no revised_arr_utc)
function computedETA(f: Flight): string | null {
  if (!f.actual_dep_utc || !f.duration_min) return null
  if (f.actual_arr_utc || f.revised_arr_utc) return null
  const ms = new Date(f.actual_dep_utc).getTime() + f.duration_min * 60_000
  return new Date(ms).toISOString()
}

function calcDelay(schedHHMM: string, actualISO: string | null): number | null {
  if (!actualISO || !schedHHMM) return null
  const opDate = actualISO.slice(0, 10)
  return Math.round((new Date(actualISO).getTime() - new Date(`${opDate}T${schedHHMM}:00Z`).getTime()) / 60_000)
}

// Sort key: actual → revised → scheduled, in Syria local minutes (UTC+3).
// Midnight-crossing flights (arr 00:16 local) must sort to the start of the day,
// not the end — raw UTC minutes would place them at minute 1276 instead of 16.
function effectiveLocalMin(f: Flight, v: View): number {
  const iso = v === 'arr'
    ? (f.actual_arr_utc ?? f.revised_arr_utc)
    : (f.actual_dep_utc ?? f.revised_dep_utc)
  if (iso) {
    const localMs = new Date(iso).getTime() + 3 * 3_600_000
    const d = new Date(localMs)
    return d.getUTCHours() * 60 + d.getUTCMinutes()
  }
  // arr_time_utc / dep_time_utc are UTC HH:MM — shift to Syria local
  const hhmm = v === 'arr' ? f.arr_time_utc : f.dep_time_utc
  if (!hhmm) return 0
  const [h, m] = hhmm.split(':').map(Number)
  return (h * 60 + m + 3 * 60) % 1440
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
      className={`rounded-lg object-cover shrink-0${LOGO_WHITE_BG.has(iata) ? ' bg-white p-0.5' : ''}`}
      onError={handleError}
    />
  )
}

// ── Flight progress bar (en-route only) ─────────────────────────────────────
function FlightProgress({ depUtc, durationMin }: { depUtc: string; durationMin: number }) {
  const [pct, setPct] = useState(0)
  useEffect(() => {
    const update = () => {
      const dep = new Date(depUtc).getTime()
      const p = Math.min(100, Math.max(0, ((Date.now() - dep) / (durationMin * 60_000)) * 100))
      setPct(p)
    }
    update()
    const t = setInterval(update, 30_000)
    return () => clearInterval(t)
  }, [depUtc, durationMin])

  return (
    <div className="h-0.5 bg-gray-800 rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-1000"
        style={{ width: `${pct.toFixed(1)}%`, background: 'linear-gradient(90deg, #0284c7, #06b6d4)' }}
      />
    </div>
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

function actualColor(hasActual: boolean, delayMin: number | null): string {
  if (!hasActual) return 'text-yellow-400'       // estimated / revised only
  if (delayMin !== null && delayMin > 2) return 'text-orange-400'  // departed/arrived late
  return 'text-green-400'                         // on time or early
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
  const isArr   = view === 'arr'
  const status  = effectiveStatus(f)
  const isCancelled = status === 'Cancelled'

  // Departures: dep = Syria local (+3), arr = destination local
  // Arrivals:   dep = origin local,     arr = Syria local (+3)
  const depOff = isArr ? tzOffset(f.dep_iata) : 3
  const arrOff = isArr ? 3 : tzOffset(f.arr_iata)

  const depSched  = fmtLocal(f.dep_time_utc, depOff)
  const arrSched  = fmtLocal(f.arr_time_utc, arrOff)
  const depActual = fmtLocal(f.actual_dep_utc ?? f.revised_dep_utc, depOff)
  const arrActual = fmtLocal(f.actual_arr_utc ?? f.revised_arr_utc, arrOff)

  const depDelay = calcDelay(f.dep_time_utc, f.actual_dep_utc ?? f.revised_dep_utc)
  const arrDelay = calcDelay(f.arr_time_utc, f.actual_arr_utc ?? f.revised_arr_utc)

  const statusCfg = STATUS[status] ?? STATUS.Unknown
  const borderColor = isCancelled ? '#7f1d1d' : statusCfg.color
  const depForProgress = f.actual_dep_utc ?? f.revised_dep_utc
    ?? (f.sched_dep_unix ? new Date(f.sched_dep_unix * 1000).toISOString() : null)
  const showProgress = (status === 'Departed' || status === 'En Route' || status === 'Approaching')
    && !!depForProgress && f.duration_min > 0 && !f.actual_arr_utc

  return (
    <div
      className={`bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col ${isCancelled ? 'opacity-60' : ''}`}
      style={{ borderLeftColor: borderColor, borderLeftWidth: '3px' }}
    >
      <div className="p-4 flex flex-col gap-3">

      {/* Row 1: Airline logo + name + status */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <AirlineLogo iata={f.airline_iata} flag={f.country_flag} name={f.airline_name} />
          <div className="min-w-0">
            <p className="text-white font-semibold text-sm leading-tight truncate">{f.airline_name}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-gray-300 text-xs font-mono font-medium">{f.iata_number}</span>
            </div>
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Row 2: Route */}
      <div className="flex items-center gap-2">
        <div className="text-left min-w-[5rem]">
          <p className="text-white font-bold text-sm leading-tight truncate">{airportFlag(f.dep_iata)} {city(f.dep_iata)}</p>
          <p className="text-gray-500 text-xs font-mono">{f.dep_iata}</p>
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
        <div className="text-right min-w-[5rem]">
          <p className="text-white font-bold text-sm leading-tight truncate">{airportFlag(f.arr_iata)} {city(f.arr_iata)}</p>
          <p className="text-gray-500 text-xs font-mono">{f.arr_iata}</p>
        </div>
      </div>

      {/* Row 3: Times + details */}
      <div className="flex items-start justify-between gap-2">

        <div className="min-w-[3.5rem]">
          <p className="text-gray-500 text-xs mb-0.5">Dep</p>
          <p className={`font-mono font-semibold text-base ${
            isCancelled       ? 'line-through text-gray-600' :
            f.actual_dep_utc  ? 'text-green-400' :
            f.revised_dep_utc ? 'text-yellow-400' :
                                'text-white'
          }`}>
            {(f.actual_dep_utc || f.revised_dep_utc) ? depActual : depSched}
          </p>
          <DelayBadge min={depDelay} />
        </div>

        <div className="flex-1 flex flex-col items-center justify-center gap-0.5">
          {f.aircraft_type && <p className="text-gray-600 text-xs">{f.aircraft_type}</p>}
          {(isArr ? f.arr_terminal : f.dep_terminal) && (
            <p className="text-gray-500 text-xs">T{isArr ? f.arr_terminal : f.dep_terminal}</p>
          )}
          {(isArr ? f.arr_gate : f.dep_gate) && (
            <p className="text-gray-500 text-xs">Gate {isArr ? f.arr_gate : f.dep_gate}</p>
          )}
          {isArr && f.arr_baggage && (
            <p className="text-sky-600 text-xs">Belt {f.arr_baggage}</p>
          )}
        </div>

        <div className="min-w-[3.5rem] text-right">
          <p className="text-gray-500 text-xs mb-0.5">Arr</p>
          <p className={`font-mono font-semibold text-base ${
            isCancelled       ? 'line-through text-gray-600' :
            f.actual_arr_utc  ? 'text-green-400' :
            f.revised_arr_utc ? 'text-yellow-400' :
                                'text-white'
          }`}>
            {(f.actual_arr_utc || f.revised_arr_utc) ? arrActual : arrSched}
          </p>
          {computedETA(f) && !f.actual_arr_utc && !f.revised_arr_utc && !isCancelled && (
            <p className="font-mono text-xs mt-0.5 text-orange-400" title="Estimated (ATD + block time)">
              ~{fmtLocal(computedETA(f), arrOff)}
            </p>
          )}
          {isArr && <DelayBadge min={arrDelay} />}
        </div>
      </div>

      </div>
      {showProgress && (
        <FlightProgress depUtc={depForProgress!} durationMin={f.duration_min} />
      )}
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

const TAB_LABELS: Record<Tab, string> = { [-1]: 'Yesterday', 0: 'Today', 1: 'Tomorrow' }

function tabDateLabel(offset: number): string {
  const d = syriaDate(offset)
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export default function BoardPage() {
  const [tab, setTab]         = useState<Tab>(0)
  const [view, setView]       = useState<View>('arr')
  const [airport, setAirport] = useState<Airport>('DAM')
  const [flights, setFlights] = useState<Flight[]>([])
  const [loading, setLoading] = useState(true)
  const [date, setDate]               = useState('')

  // Version counter: each load call captures a version; stale completions are discarded.
  // Prevents the silent auto-refresh (tab=0) from overwriting a newer tab switch load.
  const loadVer = useRef(0)

  const load = useCallback(async (offsetDays: number, silent = false) => {
    const ver = ++loadVer.current
    if (!silent) setLoading(true)
    const d = syriaDate(offsetDays)
    setDate(d)
    try {
      const res = await fetch(`/api/flightboard?date=${d}`)
      const json = await res.json()
      if (ver === loadVer.current) setFlights(json.flights ?? [])
    } catch {
      if (!silent && ver === loadVer.current) setFlights([])
    } finally {
      if (!silent && ver === loadVer.current) setLoading(false)
    }
  }, [])

  // Warm the FR24 cache for a given airport: fetch the live widget data from FR24
  // and write it through to fr24_daily_cache so the board picks up intraday status updates.
  // depth=0 (default): also warms origin airports of arrivals so their "Departed" status
  // wins in the flightboard dedup over the destination's stale "Scheduled" arrival entry.
  // depth=1: leaf call — only writes the airport's own data, no further recursion.
  // Always holds the latest load function so warmFR24Cache can call it without
  // being in its dependency array (warmFR24Cache has [] deps to avoid re-creation).
  const loadRef = useRef(load)
  useEffect(() => { loadRef.current = load }, [load])

  const warmFR24Cache = useCallback((airportCode: string, depth = 0) => {
    const TZ = 'Asia/Damascus'
    const flightDate = new Date().toLocaleDateString('en-CA', { timeZone: TZ })
    const ts = Math.floor(new Date(flightDate + 'T00:00:00+03:00').getTime() / 1000)
    const url = `https://api.flightradar24.com/common/v1/airport.json?code=${airportCode}&plugin=&plugin-setting[schedule][mode]=&plugin-setting[schedule][timestamp]=${ts}&page=1&limit=100&fleet=&token=`
    fetch(url)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        const sched = data?.result?.response?.airport?.pluginData?.schedule ?? {}
        const REG_TO_FLIGHT: Record<string, string> = { 'YK-BAA': 'FYC728' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const normFlight = (f: any) => {
          const fl = f?.flight
          if (!fl) return null
          const reg = fl.aircraft?.registration ?? null
          const num = fl.identification?.number?.default ?? fl.identification?.callsign ?? (reg ? REG_TO_FLIGHT[reg] : null) ?? reg ?? null
          const schedDep = fl.time?.scheduled?.departure ?? null
          const schedArr = fl.time?.scheduled?.arrival   ?? null
          if (!schedDep || !schedArr) return null
          const flight = { num, fr24_id: fl.identification?.id ?? null, airline: fl.airline?.name ?? null, airline_iata: fl.airline?.code?.iata ?? null, dep_iata: fl.airport?.origin?.code?.iata ?? null, arr_iata: fl.airport?.destination?.code?.iata ?? null, sched_dep: schedDep, sched_arr: schedArr, duration_min: Math.round((schedArr - schedDep) / 60), status: fl.status?.text ?? null, est_dep: fl.time?.estimated?.departure ?? null, est_arr: fl.time?.estimated?.arrival ?? null, real_dep: fl.time?.real?.departure ?? null, real_arr: fl.time?.real?.arrival ?? null }
          if (flight.duration_min > 300) return null
          return flight
        }
        const byDate: Record<string, { arrivals: object[]; departures: object[] }> = {}
        const bucket = (d: string) => { if (!byDate[d]) byDate[d] = { arrivals: [], departures: [] }; return byDate[d] }
        for (const f of (sched.departures?.data ?? [])) {
          const flight = normFlight(f); if (!flight) continue
          bucket(new Date(flight.sched_dep * 1000).toLocaleDateString('en-CA', { timeZone: TZ })).departures.push(flight)
        }
        for (const f of (sched.arrivals?.data ?? [])) {
          const flight = normFlight(f); if (!flight) continue
          bucket(new Date(flight.sched_arr * 1000).toLocaleDateString('en-CA', { timeZone: TZ })).arrivals.push(flight)
        }
        // Wait for ALL cache writes to finish, then reload the board (depth=0 only —
        // origin-airport warms at depth=1 don't need to trigger a reload themselves).
        const writes = Object.entries(byDate).map(([d, v]) =>
          fetch('/api/fr24-cache', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ airport_iata: airportCode, flight_date: d, ...v }) }).catch(() => {})
        )
        if (depth === 0) {
          Promise.all(writes).then(() => loadRef.current(0, true)).catch(() => {})
        }
        // Warm origin airports of arrivals so the flightboard can show "Departed" status
        // for in-flight arrivals (the origin knows departure status; destination only knows landing).
        if (depth === 0) {
          const origins = new Set<string>()
          for (const f of (sched.arrivals?.data ?? [])) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const dep = (f as any)?.flight?.airport?.origin?.code?.iata
            if (dep && dep !== airportCode) origins.add(dep as string)
          }
          origins.forEach(origin => warmFR24Cache(origin, 1))
        }
      })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(tab) }, [tab, load])
  useEffect(() => {
    if (tab !== 0) return
    const loadTimer = setInterval(() => load(0, true), 60_000)
    const warmTimer = setInterval(() => {
      warmFR24Cache('DAM')
      warmFR24Cache('ALP')
    }, 5 * 60_000)
    return () => { clearInterval(loadTimer); clearInterval(warmTimer) }
  }, [tab, load, warmFR24Cache])

  // On mount: warm both airports. Reload is triggered inside warmFR24Cache once writes land.
  useEffect(() => {
    warmFR24Cache('DAM')
    warmFR24Cache('ALP')
  }, [warmFR24Cache])

  // When the user switches airport tabs: warm the selected airport, then silently
  // reload the board ~4 s later so the freshly-written cache data is visible immediately.
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    warmFR24Cache(airport)
    const timer = setTimeout(() => load(tab, true), 4000)
    return () => clearTimeout(timer)
  }, [airport]) // eslint-disable-line react-hooks/exhaustive-deps

  const byViewAndAirport = (() => {
    // Cache is bucketed by Syria operating date (sched_dep for dep, sched_arr for arr),
    // so what's in today's cache belongs to today — no midnight-crossing adjustments needed.
    if (view === 'dep') return flights.filter(f => f.dep_iata === airport)
    return flights.filter(f => f.arr_iata === airport)
  })()

  // Sort by effective time: actual → revised → scheduled (Syria local minutes)
  const sorted = [...byViewAndAirport].sort((a, b) => effectiveLocalMin(a, view) - effectiveLocalMin(b, view))

  const total     = sorted.length
  const landed    = sorted.filter(f => ['Arrived', 'Landed'].includes(effectiveStatus(f))).length
  const cancelled = sorted.filter(f => effectiveStatus(f) === 'Cancelled').length
  const enroute   = sorted.filter(f => ['En Route', 'Departed', 'Approaching'].includes(effectiveStatus(f))).length

  const dateLabel = date
    ? new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long'
      })
    : ''

  const nowSyriaHHMM = (() => {
    const d = new Date(Date.now() + 3 * 3_600_000)
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  })()

  const nowSyriaMin = Math.floor((Date.now() + 3 * 3_600_000) / 60_000) % 1440

  const nowIdx = tab === 0
    ? sorted.findIndex(f => effectiveLocalMin(f, view) >= nowSyriaMin)
    : -1

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
              <div className="leading-tight">{TAB_LABELS[t]}</div>
              <div className={`text-xs font-normal mt-0.5 ${tab === t ? 'text-blue-200' : 'text-gray-500'}`}>
                {tabDateLabel(t)}
              </div>
            </button>
          ))}
        </div>

        {/* ── 4 controls: Departures / Arrivals | DAM / ALP ── */}
        <div className="max-w-2xl mx-auto px-4 pb-3">
          <div className="flex bg-gray-800 rounded-xl p-1 gap-1">
            {(['dep', 'arr'] as View[]).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  view === v ? 'bg-white text-gray-900' : 'text-gray-400 hover:text-white'
                }`}
              >
                {v === 'dep' ? 'Departures' : 'Arrivals'}
              </button>
            ))}
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
        {!loading && sorted.length > 0 && (
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
        {!loading && sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-2 text-center">
            <span className="text-4xl">✈</span>
            <p className="text-gray-400 font-medium">
              No {view === 'arr' ? 'arrivals' : 'departures'}
            </p>
            <p className="text-gray-600 text-sm">{airport} · {dateLabel}</p>
          </div>
        )}

        {/* Flight cards */}
        {!loading && (
          <div className="flex flex-col gap-3">
            {sorted.map((f, i) => (
              <Fragment key={`${f.iata_number}-${f.dep_iata}-${f.arr_iata}-${f.dep_time_utc}-${f.arr_time_utc}`}>
                {i === nowIdx && (
                  <div className="flex items-center gap-2 py-1">
                    <div className="flex-1 h-px bg-blue-900" />
                    <span className="text-blue-400 text-xs font-semibold tabular-nums">{nowSyriaHHMM} · Now</span>
                    <div className="flex-1 h-px bg-blue-900" />
                  </div>
                )}
                <FlightCard f={f} view={view} />
              </Fragment>
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

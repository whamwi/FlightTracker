'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

const SYRIA = new Set(['DAM', 'ALP'])

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const DAY_SHORT: Record<string, string> = {
  mon: 'Mo', tue: 'Tu', wed: 'We', thu: 'Th', fri: 'Fr', sat: 'Sa', sun: 'Su',
}
const DAY_FULL: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
}

interface ScheduleRow {
  id: number
  dep_iata: string
  arr_iata: string
  dep_time: string
  arr_time: string
  dep_time_utc: string
  arr_time_utc: string
  duration_min: number
  days_of_week: string[]
  codeshare_iata: string | null
  iata_number: string
  broadcast_callsign: string
  airline_name: string
  country_flag: string
}

type Airport   = 'all' | 'DAM' | 'ALP'
type Direction = 'all' | 'dep' | 'arr'

function fmtDuration(min: number) {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m}m`
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function DayBadges({ days }: { days: string[] }) {
  if (days.length === 7) {
    return <span className="text-xs text-emerald-400 font-medium tracking-wide">Daily</span>
  }
  return (
    <div className="flex gap-0.5">
      {DAY_ORDER.map(d => (
        <span
          key={d}
          title={DAY_FULL[d]}
          className={`w-[18px] h-[18px] rounded-sm text-[9px] font-bold flex items-center justify-center leading-none
            ${days.includes(d) ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-600'}`}
        >
          {DAY_SHORT[d][0]}
        </span>
      ))}
    </div>
  )
}

function RouteCell({ dep, arr }: { dep: string; arr: string }) {
  const depSyria = SYRIA.has(dep)
  const arrSyria = SYRIA.has(arr)
  return (
    <span className="font-mono text-sm whitespace-nowrap">
      <span className={depSyria ? 'text-emerald-400 font-bold' : 'text-gray-300'}>{dep}</span>
      <span className="text-gray-600 mx-1.5">→</span>
      <span className={arrSyria ? 'text-emerald-400 font-bold' : 'text-gray-300'}>{arr}</span>
    </span>
  )
}

function FilterBtn({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap
        ${active
          ? 'bg-blue-600 text-white'
          : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'}`}
    >
      {children}
    </button>
  )
}

export default function SchedulePage() {
  const [rows, setRows]       = useState<ScheduleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const [airport,   setAirport]   = useState<Airport>('all')
  const [direction, setDirection] = useState<Direction>('all')
  const [day,       setDay]       = useState<string>('all')

  useEffect(() => {
    fetch('/api/schedule')
      .then(r => r.json())
      .then(d => {
        if (d.ok) setRows(d.rows)
        else setError('Failed to load schedule')
      })
      .catch(() => setError('Network error'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => rows.filter(r => {
    if (airport !== 'all' && r.dep_iata !== airport && r.arr_iata !== airport) return false
    if (direction === 'dep' && !SYRIA.has(r.dep_iata)) return false
    if (direction === 'arr' && !SYRIA.has(r.arr_iata)) return false
    if (day !== 'all' && !r.days_of_week.includes(day)) return false
    return true
  }), [rows, airport, direction, day])

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 shrink-0">
        <Link
          href="/"
          className="text-gray-400 hover:text-white text-sm transition-colors"
        >
          ← Map
        </Link>
        <h1 className="text-base font-semibold">Flight Schedule</h1>
        <span className="ml-auto font-mono text-sm text-gray-400">
          {loading ? '…' : `${filtered.length} / ${rows.length}`}
        </span>
      </header>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="px-4 py-3 space-y-2.5 border-b border-gray-800 shrink-0">
        {/* Airport */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 w-16 shrink-0">Airport</span>
          <FilterBtn active={airport === 'all'} onClick={() => setAirport('all')}>All</FilterBtn>
          <FilterBtn active={airport === 'DAM'} onClick={() => setAirport('DAM')}>Damascus · DAM</FilterBtn>
          <FilterBtn active={airport === 'ALP'} onClick={() => setAirport('ALP')}>Aleppo · ALP</FilterBtn>
        </div>

        {/* Direction */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 w-16 shrink-0">Direction</span>
          <FilterBtn active={direction === 'all'} onClick={() => setDirection('all')}>Both</FilterBtn>
          <FilterBtn active={direction === 'dep'} onClick={() => setDirection('dep')}>Departures</FilterBtn>
          <FilterBtn active={direction === 'arr'} onClick={() => setDirection('arr')}>Arrivals</FilterBtn>
        </div>

        {/* Day */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 w-16 shrink-0">Day</span>
          <FilterBtn active={day === 'all'} onClick={() => setDay('all')}>All</FilterBtn>
          {DAY_ORDER.map(d => (
            <FilterBtn key={d} active={day === d} onClick={() => setDay(d)}>
              {DAY_FULL[d]}
            </FilterBtn>
          ))}
        </div>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="py-24 text-center text-gray-500 text-sm">Loading schedule…</div>
        )}
        {error && (
          <div className="py-24 text-center text-red-400 text-sm">{error}</div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="py-24 text-center text-gray-500 text-sm">No flights match these filters</div>
        )}
        {!loading && !error && filtered.length > 0 && (
          <table className="w-full text-sm min-w-[680px]">
            <thead className="sticky top-0 bg-gray-900 z-10">
              <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                <th className="px-4 py-2.5 font-medium">Airline</th>
                <th className="px-4 py-2.5 font-medium">Flight</th>
                <th className="px-4 py-2.5 font-medium">Route</th>
                <th className="px-4 py-2.5 font-medium">Departs</th>
                <th className="px-4 py-2.5 font-medium">Arrives</th>
                <th className="px-4 py-2.5 font-medium">Duration</th>
                <th className="px-4 py-2.5 font-medium">Days</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr
                  key={r.id}
                  className="border-b border-gray-800/40 hover:bg-gray-800/25 transition-colors"
                >
                  {/* Airline */}
                  <td className="px-4 py-3">
                    <span className="mr-1.5 text-base leading-none">{r.country_flag}</span>
                    <span className="text-gray-200 text-xs">{r.airline_name}</span>
                  </td>

                  {/* Flight # */}
                  <td className="px-4 py-3 whitespace-nowrap">
                    <p className="font-mono text-gray-200 text-xs font-medium">{r.iata_number}</p>
                    <p className="font-mono text-gray-500 text-[11px]">{r.broadcast_callsign}</p>
                    {r.codeshare_iata && (
                      <p className="font-mono text-gray-600 text-[10px]">/ {r.codeshare_iata}</p>
                    )}
                  </td>

                  {/* Route */}
                  <td className="px-4 py-3">
                    <RouteCell dep={r.dep_iata} arr={r.arr_iata} />
                  </td>

                  {/* Departs */}
                  <td className="px-4 py-3 font-mono text-gray-100 whitespace-nowrap">
                    {r.dep_time}
                  </td>

                  {/* Arrives */}
                  <td className="px-4 py-3 font-mono text-gray-100 whitespace-nowrap">
                    {r.arr_time}
                  </td>

                  {/* Duration */}
                  <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                    {fmtDuration(r.duration_min)}
                  </td>

                  {/* Days */}
                  <td className="px-4 py-3">
                    <DayBadges days={r.days_of_week} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { AIRLINE_LOGOS, LOGO_WHITE_BG } from '@/lib/airlines'
import { airportCity, airportFlag as _apFlag, airportOffset, loadGeoData } from '@/lib/geo-data'

const cityName = (iata: string) => airportCity[iata] ?? iata
const tzOff    = (iata: string) => airportOffset[iata] ?? 3

const C = {
  bg:         '#EDEBE0',
  surface:    '#FFFFFF',
  sunken:     '#F7F5EC',
  ink:        '#161616',
  secondary:  '#3D3A3B',
  muted:      '#8A8578',
  border:     '#D8D3BF',
  forest:     '#054239',
  forestMid:  '#428177',
  golden:     '#988561',
  goldenBg:   '#F3EFE0',
  goldenBdr:  '#DFD3B4',
  goldenText: '#6E5F3C',
  wine:       '#6B1F2A',
}

type StatusCfg = { label: string; bg: string; text: string; dot?: string; border?: string }
const STATUS: Record<string, StatusCfg> = {
  Scheduled:   { label: 'Scheduled',   bg: '#F7F5EC',   text: C.muted },
  Expected:    { label: 'Expected',    bg: C.goldenBg,  text: C.goldenText, dot: C.golden,    border: C.goldenBdr },
  CheckIn:     { label: 'Check-in',    bg: C.goldenBg,  text: C.goldenText, dot: C.golden,    border: C.goldenBdr },
  Boarding:    { label: 'Boarding',    bg: C.goldenBg,  text: C.goldenText, dot: C.golden,    border: C.goldenBdr },
  GateClosed:  { label: 'Gate Closed', bg: C.goldenBg,  text: C.goldenText, dot: C.golden,    border: C.goldenBdr },
  Departed:    { label: 'Departed',    bg: C.forestMid, text: '#fff',       dot: '#fff' },
  'En Route':  { label: 'En route',    bg: C.forestMid, text: '#fff',       dot: '#fff' },
  Approaching: { label: 'Approaching', bg: C.forest,    text: '#EDEBE0',    dot: '#EDEBE0' },
  Arrived:     { label: 'Arrived',     bg: '#E6EFEC',   text: '#002623',    dot: C.forest,    border: '#B4CFC9' },
  Landed:      { label: 'Arrived',     bg: '#E6EFEC',   text: '#002623',    dot: C.forest,    border: '#B4CFC9' },
  Cancelled:   { label: 'Cancelled',   bg: C.wine,      text: '#fff' },
  Diverted:    { label: 'Diverted',    bg: '#7f3100',   text: '#fff' },
  Delayed:     { label: 'Delayed',     bg: C.goldenBg,  text: C.goldenText, dot: C.golden,    border: C.goldenBdr },
  Unknown:     { label: 'Unknown',     bg: '#E4E1D2',   text: C.muted },
}

type Flight = {
  iata_number: string
  airline_name: string
  airline_iata: string
  country_flag: string
  dep_iata: string
  arr_iata: string
  dep_time_utc: string
  arr_time_utc: string
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
  date: string
}

function fmtNum(num: string): string {
  const m = num.match(/^([A-Z]{2,3})(\d+.*)$/)
  return m ? `${m[1]} ${m[2]}` : num
}

function fmtDate(iso: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  })
}

function utcHHMMtoLocal(hhmm: string, offsetH: number): string {
  if (!hhmm) return '—'
  const [h, m] = hhmm.slice(0, 5).split(':').map(Number)
  const total = ((h * 60 + m + Math.round(offsetH * 60)) % 1440 + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function isoToLocal(iso: string | null, offsetH: number): string {
  if (!iso) return '—'
  const ms = new Date(iso).getTime() + Math.round(offsetH * 3_600_000)
  const d  = new Date(ms)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function calcDelayMin(schedHHMM: string, actualISO: string, date: string): number {
  if (!actualISO || !schedHHMM) return 0
  const actualMs = new Date(actualISO).getTime()
  let schedMs    = new Date(`${date}T${schedHHMM}:00Z`).getTime()
  if (schedMs - actualMs > 12 * 3_600_000) schedMs -= 86_400_000
  return Math.round((actualMs - schedMs) / 60_000)
}

function durationLabel(min: number) {
  const h = Math.floor(min / 60), m = min % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function AirlineLogo({ iata, name }: { iata: string; name: string }) {
  const initials = iata.slice(0, 2).toUpperCase()
  const [src, setSrc]       = useState(AIRLINE_LOGOS[iata] ?? (iata ? `https://images.flightsfrom.com/airlines/100/${iata}_100px.png` : ''))
  const [failed, setFailed] = useState(!iata)

  if (failed || !src) return (
    <div style={{ width: 52, height: 52, borderRadius: 14, background: '#E4E1D2', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted, fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
      {initials}
    </div>
  )
  return (
    <div style={{ width: 52, height: 52, borderRadius: 14, overflow: 'hidden', flexShrink: 0, background: LOGO_WHITE_BG.has(iata) ? '#fff' : '#F7F5EC', border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <img src={src} alt={name} width={52} height={52} style={{ objectFit: 'contain' }}
        onError={() => { if (src === AIRLINE_LOGOS[iata]) { setSrc(`https://images.flightsfrom.com/airlines/100/${iata}_100px.png`) } else { setFailed(true) } }} />
    </div>
  )
}

function ProgressBar({ depUtc, durationMin }: { depUtc: string; durationMin: number }) {
  const calc = () => Math.min(100, Math.max(0, ((Date.now() - new Date(depUtc).getTime()) / (durationMin * 60_000)) * 100))
  const [pct, setPct] = useState(calc)
  useEffect(() => {
    const t = setInterval(() => setPct(calc()), 30_000)
    return () => clearInterval(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depUtc, durationMin])
  const remaining = Math.round((1 - pct / 100) * durationMin)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
      {remaining > 0 && (
        <span style={{ textAlign: 'center', fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.muted }}>
          {durationLabel(remaining)} left
        </span>
      )}
      <div style={{ width: '100%', height: 4, borderRadius: 99, background: '#E0DCCB' }}>
        <div style={{ width: `${Math.max(2, pct)}%`, height: '100%', borderRadius: 99, background: C.forestMid }} />
      </div>
    </div>
  )
}

export default function FlightDetail({ callsign }: { callsign: string }) {
  const [flight, setFlight]     = useState<Flight | null>(null)
  const [loading, setLoading]   = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(0)

  useEffect(() => { loadGeoData() }, [])

  const fetchFlight = useCallback(async () => {
    try {
      const res = await fetch(`/api/flight?num=${encodeURIComponent(callsign)}`)
      if (res.status === 404) { setNotFound(true); setLoading(false); return }
      if (!res.ok) return
      const data = await res.json()
      if (data.ok) { setFlight(data.flight); setNotFound(false) }
    } catch {}
    setLoading(false)
    setLastRefresh(Date.now())
  }, [callsign])

  useEffect(() => {
    fetchFlight()
    const t = setInterval(fetchFlight, 60_000)
    return () => clearInterval(t)
  }, [fetchFlight])

  const isEnRoute   = flight && ['Departed', 'En Route', 'Approaching'].includes(flight.status)
  const isCancelled = flight?.status === 'Cancelled'
  const statusCfg   = flight ? (STATUS[flight.status] ?? STATUS.Unknown) : null

  const depOffset = flight ? tzOff(flight.dep_iata) : 3
  const arrOffset = flight ? tzOff(flight.arr_iata) : 3

  const schedDepLocal  = flight ? utcHHMMtoLocal(flight.dep_time_utc, depOffset) : '—'
  const schedArrLocal  = flight ? utcHHMMtoLocal(flight.arr_time_utc, arrOffset) : '—'
  const actualDepLocal = flight ? isoToLocal(flight.actual_dep_utc, depOffset) : '—'
  const actualArrLocal = flight ? isoToLocal(flight.actual_arr_utc, arrOffset) : '—'
  const revisedDepLocal = flight ? isoToLocal(flight.revised_dep_utc, depOffset) : '—'
  const revisedArrLocal = flight ? isoToLocal(flight.revised_arr_utc, arrOffset) : '—'

  const depDelay = flight?.actual_dep_utc ? calcDelayMin(flight.dep_time_utc, flight.actual_dep_utc, flight.date) : 0
  const arrDelay = flight?.actual_arr_utc ? calcDelayMin(flight.arr_time_utc, flight.actual_arr_utc, flight.date) : 0

  const boardAirport = flight
    ? (['DAM', 'ALP'].includes(flight.arr_iata) ? flight.arr_iata : flight.dep_iata) || 'DAM'
    : 'DAM'

  function handleShare() {
    if (!flight) return
    const text = `${fmtNum(flight.iata_number)} · ${flight.dep_iata} → ${flight.arr_iata} · ${statusCfg?.label}`
    if (typeof navigator !== 'undefined' && navigator.share) {
      navigator.share({ title: text, url: window.location.href }).catch(() => {})
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(window.location.href).catch(() => {})
    }
  }

  return (
    <div style={{ minHeight: '100dvh', background: C.bg, fontFamily: "'Instrument Sans', system-ui, sans-serif" }}>
      <style>{`* { box-sizing: border-box; } @keyframes spin { to { transform: rotate(360deg) } }`}</style>

      {/* Nav */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, height: 56, display: 'flex', alignItems: 'center', padding: '0 16px', gap: 12 }}>
        <Link href="/board" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 10, border: `1px solid ${C.border}`, background: C.sunken, color: C.ink, textDecoration: 'none', flexShrink: 0 }}>
          <svg width={16} height={16} viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </Link>
        <span style={{ font: `700 15px/1 'Instrument Sans', system-ui`, color: C.ink, letterSpacing: '-.01em' }}>FlySyria Tracker</span>
      </div>

      <div style={{ maxWidth: 480, margin: '0 auto', padding: '24px 16px 48px' }}>

        {/* Loading */}
        {loading && !flight && (
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
            <div style={{ width: 28, height: 28, border: `3px solid ${C.border}`, borderTopColor: C.forest, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          </div>
        )}

        {/* Not found */}
        {notFound && !flight && (
          <div style={{ textAlign: 'center', paddingTop: 80 }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>✈️</div>
            <div style={{ font: `700 20px/1.2 'Instrument Sans', system-ui`, color: C.ink, marginBottom: 8 }}>Flight not found</div>
            <div style={{ font: `400 14px/1.5 'Instrument Sans', system-ui`, color: C.muted }}>
              No data for {fmtNum(callsign)} today or yesterday
            </div>
            <Link href="/board" style={{ display: 'inline-block', marginTop: 24, font: `600 14px/1 'Instrument Sans', system-ui`, color: C.forest, textDecoration: 'none' }}>
              ← View all flights
            </Link>
          </div>
        )}

        {/* Flight data */}
        {flight && (
          <>
            {/* Airline hero */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
              <AirlineLogo iata={flight.airline_iata} name={flight.airline_name} />
              <div>
                <div style={{ font: `500 14px/1 'Instrument Sans', system-ui`, color: C.secondary, marginBottom: 5 }}>
                  {flight.airline_name}{flight.country_flag ? ` ${flight.country_flag}` : ''}
                </div>
                <div style={{ font: `700 22px/1 'Instrument Sans', system-ui`, color: C.ink, letterSpacing: '-.025em', marginBottom: 4 }}>
                  {fmtNum(flight.iata_number)}
                </div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.muted }}>
                  {fmtDate(flight.date)}
                </div>
              </div>
            </div>

            {/* Status badge */}
            {statusCfg && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: statusCfg.bg, color: statusCfg.text, border: statusCfg.border ? `1px solid ${statusCfg.border}` : 'none', borderRadius: 99, padding: '8px 14px' }}>
                  {statusCfg.dot && <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusCfg.dot, flexShrink: 0 }} />}
                  <span style={{ font: `700 14px/1 'Instrument Sans', system-ui` }}>{statusCfg.label}</span>
                </div>
              </div>
            )}

            {/* Route card */}
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 20, padding: '18px 20px', marginBottom: 12 }}>

              {/* Airport row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div>
                  <div style={{ font: `700 28px/1 'Instrument Sans', system-ui`, color: C.ink, letterSpacing: '-.025em' }}>{flight.dep_iata}</div>
                  <div style={{ font: `400 12px/1 'Instrument Sans', system-ui`, color: C.muted, marginTop: 4 }}>{cityName(flight.dep_iata)}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  {flight.duration_min > 0 && (
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.muted }}>{durationLabel(flight.duration_min)}</span>
                  )}
                  <svg width={52} height={12} viewBox="0 0 52 12" fill="none">
                    <line x1="0" y1="6" x2="44" y2="6" stroke={C.border} strokeWidth="1.5"/>
                    <path d="M38 2l8 4-8 4" stroke={C.border} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ font: `700 28px/1 'Instrument Sans', system-ui`, color: C.ink, letterSpacing: '-.025em' }}>{flight.arr_iata}</div>
                  <div style={{ font: `400 12px/1 'Instrument Sans', system-ui`, color: C.muted, marginTop: 4 }}>{cityName(flight.arr_iata)}</div>
                </div>
              </div>

              <div style={{ height: 1, background: C.border, marginBottom: 16 }} />

              {/* Times */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                {/* Departure side */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                  <span style={{ font: `500 10px/1 'Instrument Sans', system-ui`, color: C.muted, textTransform: 'uppercase', letterSpacing: '.07em' }}>Departure</span>

                  {flight.actual_dep_utc ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ font: `700 26px/1 'Instrument Sans', system-ui`, color: isCancelled ? C.muted : C.ink, letterSpacing: '-.025em', textDecoration: isCancelled ? 'line-through' : 'none' }}>
                          {actualDepLocal}
                        </span>
                        {Math.abs(depDelay) > 2 && (
                          <span style={{ font: `600 11px/1 'Instrument Sans', system-ui`, color: depDelay > 0 ? C.goldenText : C.forestMid }}>
                            {depDelay > 0 ? `+${depDelay}m` : `${depDelay}m`}
                          </span>
                        )}
                      </div>
                      <span style={{ font: `400 12px/1 'Instrument Sans', system-ui`, color: C.muted }}>sched {schedDepLocal}</span>
                    </>
                  ) : revisedDepLocal !== '—' ? (
                    <>
                      <span style={{ font: `700 26px/1 'Instrument Sans', system-ui`, color: C.goldenText, letterSpacing: '-.025em' }}>{revisedDepLocal}</span>
                      <span style={{ font: `400 12px/1 'Instrument Sans', system-ui`, color: C.muted }}>sched {schedDepLocal}</span>
                    </>
                  ) : (
                    <span style={{ font: `700 26px/1 'Instrument Sans', system-ui`, color: isCancelled ? C.muted : C.ink, letterSpacing: '-.025em', textDecoration: isCancelled ? 'line-through' : 'none' }}>
                      {schedDepLocal}
                    </span>
                  )}

                  {flight.dep_gate && (
                    <span style={{ font: `400 12px/1 'Instrument Sans', system-ui`, color: C.muted }}>Gate {flight.dep_gate}</span>
                  )}
                </div>

                {/* Progress bar (en route) */}
                {isEnRoute && flight.actual_dep_utc && flight.duration_min > 0 && (
                  <div style={{ flex: 1, padding: '28px 10px 0', minWidth: 60 }}>
                    <ProgressBar depUtc={flight.actual_dep_utc} durationMin={flight.duration_min} />
                  </div>
                )}

                {/* Arrival side */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, textAlign: 'right', minWidth: 0 }}>
                  <span style={{ font: `500 10px/1 'Instrument Sans', system-ui`, color: C.muted, textTransform: 'uppercase', letterSpacing: '.07em' }}>Arrival</span>

                  {flight.actual_arr_utc ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, justifyContent: 'flex-end' }}>
                        {Math.abs(arrDelay) > 2 && (
                          <span style={{ font: `600 11px/1 'Instrument Sans', system-ui`, color: arrDelay > 0 ? C.goldenText : C.forestMid }}>
                            {arrDelay > 0 ? `+${arrDelay}m` : `${arrDelay}m`}
                          </span>
                        )}
                        <span style={{ font: `700 26px/1 'Instrument Sans', system-ui`, color: C.forest, letterSpacing: '-.025em' }}>
                          {actualArrLocal}
                        </span>
                      </div>
                      <span style={{ font: `400 12px/1 'Instrument Sans', system-ui`, color: C.muted }}>sched {schedArrLocal}</span>
                    </>
                  ) : flight.revised_arr_utc ? (
                    <>
                      <span style={{ font: `700 26px/1 'Instrument Sans', system-ui`, color: C.goldenText, letterSpacing: '-.025em' }}>{revisedArrLocal}</span>
                      <span style={{ font: `400 12px/1 'Instrument Sans', system-ui`, color: C.muted }}>sched {schedArrLocal}</span>
                    </>
                  ) : (
                    <span style={{ font: `700 26px/1 'Instrument Sans', system-ui`, color: isCancelled ? C.muted : C.ink, letterSpacing: '-.025em', textDecoration: isCancelled ? 'line-through' : 'none' }}>
                      {schedArrLocal}
                    </span>
                  )}

                  {flight.arr_terminal && (
                    <span style={{ font: `400 12px/1 'Instrument Sans', system-ui`, color: C.muted }}>Terminal {flight.arr_terminal}</span>
                  )}
                  {flight.arr_gate && (
                    <span style={{ font: `400 12px/1 'Instrument Sans', system-ui`, color: C.muted }}>Gate {flight.arr_gate}</span>
                  )}
                  {flight.arr_baggage && (
                    <span style={{ font: `400 12px/1 'Instrument Sans', system-ui`, color: C.muted }}>Baggage {flight.arr_baggage}</span>
                  )}
                </div>
              </div>
            </div>

            {/* Aircraft chips */}
            {(flight.aircraft_type || flight.aircraft_reg) && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
                {flight.aircraft_type && (
                  <span style={{ font: `500 13px/1 'Instrument Sans', system-ui`, color: C.secondary, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 10px' }}>
                    {flight.aircraft_type}
                  </span>
                )}
                {flight.aircraft_reg && (
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 500, color: C.muted, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 10px' }}>
                    {flight.aircraft_reg}
                  </span>
                )}
                {flight.duration_min > 0 && (
                  <span style={{ font: `500 13px/1 'Instrument Sans', system-ui`, color: C.secondary, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 10px' }}>
                    {durationLabel(flight.duration_min)}
                  </span>
                )}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={handleShare} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: C.forest, color: '#fff', border: 'none', borderRadius: 14, padding: '14px 16px', font: `600 14px/1 'Instrument Sans', system-ui`, cursor: 'pointer' }}>
                <svg width={15} height={15} viewBox="0 0 16 16" fill="none">
                  <circle cx="12" cy="3"  r="1.8" stroke="currentColor" strokeWidth="1.5"/>
                  <circle cx="12" cy="13" r="1.8" stroke="currentColor" strokeWidth="1.5"/>
                  <circle cx="3"  cy="8"  r="1.8" stroke="currentColor" strokeWidth="1.5"/>
                  <line x1="10.3" y1="3.9" x2="4.7" y2="7.1" stroke="currentColor" strokeWidth="1.5"/>
                  <line x1="4.7"  y1="8.9" x2="10.3" y2="12.1" stroke="currentColor" strokeWidth="1.5"/>
                </svg>
                Share
              </button>
              <Link href="/board" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: C.surface, color: C.ink, border: `1px solid ${C.border}`, borderRadius: 14, padding: '14px 16px', font: `600 14px/1 'Instrument Sans', system-ui`, textDecoration: 'none' }}>
                {boardAirport} flights
                <svg width={13} height={13} viewBox="0 0 14 14" fill="none"><path d="M4 7h7M8 4l3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </Link>
            </div>

            {lastRefresh > 0 && (
              <div style={{ textAlign: 'center', marginTop: 16, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.muted }}>
                Updated {new Date(lastRefresh).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

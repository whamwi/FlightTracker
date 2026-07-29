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
  Scheduled:   { label: 'Scheduled',   bg: '#F0EEE4',   text: C.muted },
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
    <div style={{ width: 44, height: 44, borderRadius: 10, background: '#E4E1D2', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
      {initials}
    </div>
  )
  return (
    <div style={{ width: 44, height: 44, borderRadius: 10, overflow: 'hidden', flexShrink: 0, background: LOGO_WHITE_BG.has(iata) ? '#fff' : C.sunken, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <img src={src} alt={name} width={44} height={44} style={{ objectFit: 'contain' }}
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
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, padding: '0 6px' }}>
      {remaining > 0 && (
        <span style={{ textAlign: 'center', fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.muted }}>{durationLabel(remaining)} left</span>
      )}
      <div style={{ position: 'relative', height: 3, borderRadius: 99, background: '#E0DCCB' }}>
        <div style={{ width: `${Math.max(2, pct)}%`, height: '100%', borderRadius: 99, background: C.forestMid }} />
        <span style={{
          position: 'absolute', top: '50%', left: `${Math.max(2, pct)}%`,
          transform: 'translateY(-55%) translateX(-50%)',
          color: C.forestMid, fontSize: 11, lineHeight: 1, pointerEvents: 'none',
        }}>✈</span>
      </div>
    </div>
  )
}

export default function FlightDetail({ callsign }: { callsign: string }) {
  const [flight, setFlight]     = useState<Flight | null>(null)
  const [loading, setLoading]   = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(0)
  const [photo, setPhoto]       = useState<string | null>(null)

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

  // Fetch aircraft photo
  useEffect(() => {
    fetch(`/api/photo-cs/${encodeURIComponent(callsign)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.url) setPhoto(d.url) })
      .catch(() => {})
  }, [callsign])

  const isEnRoute   = flight && ['Departed', 'En Route', 'Approaching'].includes(flight.status)
  const isCancelled = flight?.status === 'Cancelled'
  const statusCfg   = flight ? (STATUS[flight.status] ?? STATUS.Unknown) : null

  const depOffset = flight ? tzOff(flight.dep_iata) : 3
  const arrOffset = flight ? tzOff(flight.arr_iata) : 3

  const schedDepLocal  = flight ? utcHHMMtoLocal(flight.dep_time_utc, depOffset) : '—'
  const schedArrLocal  = flight ? utcHHMMtoLocal(flight.arr_time_utc, arrOffset) : '—'
  const actualDepLocal = flight ? isoToLocal(flight.actual_dep_utc, depOffset) : '—'
  const actualArrLocal = flight ? isoToLocal(flight.actual_arr_utc, arrOffset) : '—'

  const depDisplay = flight?.actual_dep_utc ? actualDepLocal : schedDepLocal
  const arrDisplay = flight?.actual_arr_utc ? actualArrLocal
    : (flight?.revised_arr_utc ? isoToLocal(flight.revised_arr_utc, arrOffset) : schedArrLocal)

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
    <div style={{ minHeight: '100dvh', background: C.bg, fontFamily: "'Instrument Sans', system-ui, sans-serif", display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 0 32px' }}>
      <style>{`* { box-sizing: border-box; } @keyframes spin { to { transform: rotate(360deg) } }`}</style>

      {/* Back nav */}
      <div style={{ width: '100%', maxWidth: 360, padding: '16px 16px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Link href="/board" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 9, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, textDecoration: 'none', flexShrink: 0 }}>
          <svg width={14} height={14} viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </Link>
        <span style={{ font: `600 13px/1 'Instrument Sans', system-ui`, color: C.secondary }}>
          {flight ? fmtNum(flight.iata_number) : callsign.replace(/(\D+)(\d+)/, '$1 $2')}
        </span>
      </div>

      {/* Loading */}
      {loading && !flight && (
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
          <div style={{ width: 26, height: 26, border: `3px solid ${C.border}`, borderTopColor: C.forest, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        </div>
      )}

      {/* Not found */}
      {notFound && !flight && (
        <div style={{ textAlign: 'center', paddingTop: 60 }}>
          <div style={{ font: `700 18px/1.2 'Instrument Sans', system-ui`, color: C.ink, marginBottom: 8 }}>Flight not found</div>
          <div style={{ font: `400 13px/1.5 'Instrument Sans', system-ui`, color: C.muted }}>No data for {fmtNum(callsign)} today or yesterday</div>
          <Link href="/board" style={{ display: 'inline-block', marginTop: 20, font: `600 13px/1 'Instrument Sans', system-ui`, color: C.forest, textDecoration: 'none' }}>← All flights</Link>
        </div>
      )}

      {/* Card */}
      {flight && statusCfg && (
        <div style={{ width: '100%', maxWidth: 360, margin: '0 16px', background: C.surface, borderRadius: 20, overflow: 'hidden', border: `1px solid ${C.border}`, boxShadow: '0 2px 16px rgba(0,0,0,.07)' }}>

          {/* Aircraft photo */}
          {photo && (
            <img src={photo} alt={flight.airline_name} style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }} />
          )}

          {/* Header: logo + airline + flight num + status */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '14px 14px 10px' }}>
            <AirlineLogo iata={flight.airline_iata} name={flight.airline_name} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ font: `700 14px/1.25 'Instrument Sans', system-ui`, color: C.ink }}>{flight.airline_name}</div>
              <div style={{ font: `400 12px/1 'Instrument Sans', system-ui`, color: C.muted, marginTop: 3 }}>
                {fmtNum(flight.iata_number)}{flight.aircraft_type ? ` · ${flight.aircraft_type}` : ''}
              </div>
            </div>
            {/* Status badge */}
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: statusCfg.bg, color: statusCfg.text, border: statusCfg.border ? `1px solid ${statusCfg.border}` : 'none', borderRadius: 99, padding: '4px 9px', flexShrink: 0 }}>
              {statusCfg.dot && <div style={{ width: 6, height: 6, borderRadius: '50%', background: statusCfg.dot }} />}
              <span style={{ font: `600 11px/1 'Instrument Sans', system-ui` }}>{statusCfg.label}</span>
            </div>
          </div>

          {/* Route row: city — plane — city */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 14px 10px', gap: 8 }}>
            <div>
              <div style={{ font: `500 13px/1.2 'Instrument Sans', system-ui`, color: C.ink, whiteSpace: 'nowrap' }}>
                {_apFlag[flight.dep_iata] && <span style={{ marginRight: 4 }}>{_apFlag[flight.dep_iata]}</span>}{cityName(flight.dep_iata)}
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.muted, marginTop: 2 }}>{flight.dep_iata}</div>
            </div>

            {isEnRoute && flight.actual_dep_utc && flight.duration_min > 0
              ? <ProgressBar depUtc={flight.actual_dep_utc} durationMin={flight.duration_min} />
              : (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '0 4px' }}>
                  <div style={{ flex: 1, height: 1.5, background: C.border, borderRadius: 99 }} />
                  {flight.duration_min > 0 && (
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.muted, padding: '0 5px', whiteSpace: 'nowrap' }}>{durationLabel(flight.duration_min)}</span>
                  )}
                  <div style={{ flex: 1, height: 1.5, background: C.border, borderRadius: 99 }} />
                </div>
              )
            }

            <div style={{ textAlign: 'right' }}>
              <div style={{ font: `500 13px/1.2 'Instrument Sans', system-ui`, color: C.ink, whiteSpace: 'nowrap' }}>
                {cityName(flight.arr_iata)}{_apFlag[flight.arr_iata] && <span style={{ marginLeft: 4 }}>{_apFlag[flight.arr_iata]}</span>}
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.muted, marginTop: 2, textAlign: 'right' }}>{flight.arr_iata}</div>
            </div>
          </div>

          {/* Times */}
          <div style={{ display: 'flex', background: C.sunken, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, padding: '11px 14px' }}>
            {/* Departure */}
            <div style={{ flex: 1 }}>
              <div style={{ font: `600 9px/1 'Instrument Sans', system-ui`, color: C.muted, textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 4 }}>Departure</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                <span style={{ font: `700 22px/1 'Instrument Sans', system-ui`, color: isCancelled ? C.muted : C.ink, letterSpacing: '-.02em', textDecoration: isCancelled ? 'line-through' : 'none' }}>
                  {depDisplay}
                </span>
                {!isCancelled && Math.abs(depDelay) > 2 && (
                  <span style={{ font: `700 10px/1 'Instrument Sans', system-ui`, background: C.goldenBg, color: C.goldenText, border: `1px solid ${C.goldenBdr}`, borderRadius: 99, padding: '2px 5px' }}>
                    {depDelay > 0 ? `+${depDelay}m` : `${depDelay}m`}
                  </span>
                )}
              </div>
            </div>
            {/* Arrival */}
            <div style={{ flex: 1, textAlign: 'right' }}>
              <div style={{ font: `600 9px/1 'Instrument Sans', system-ui`, color: C.muted, textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 4 }}>Arrival</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, justifyContent: 'flex-end' }}>
                {!isCancelled && Math.abs(arrDelay) > 2 && (
                  <span style={{ font: `700 10px/1 'Instrument Sans', system-ui`, background: C.goldenBg, color: C.goldenText, border: `1px solid ${C.goldenBdr}`, borderRadius: 99, padding: '2px 5px' }}>
                    {arrDelay > 0 ? `+${arrDelay}m` : `${arrDelay}m`}
                  </span>
                )}
                <span style={{ font: `700 22px/1 'Instrument Sans', system-ui`, color: isCancelled ? C.muted : (flight.actual_arr_utc ? C.forest : C.ink), letterSpacing: '-.02em', textDecoration: isCancelled ? 'line-through' : 'none' }}>
                  {arrDisplay}
                </span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, padding: '12px 14px' }}>
            <button onClick={handleShare} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: C.forest, color: '#fff', border: 'none', borderRadius: 11, padding: '11px 12px', font: `600 13px/1 'Instrument Sans', system-ui`, cursor: 'pointer' }}>
              <svg width={13} height={13} viewBox="0 0 16 16" fill="none">
                <circle cx="12" cy="3"  r="1.8" stroke="currentColor" strokeWidth="1.5"/>
                <circle cx="12" cy="13" r="1.8" stroke="currentColor" strokeWidth="1.5"/>
                <circle cx="3"  cy="8"  r="1.8" stroke="currentColor" strokeWidth="1.5"/>
                <line x1="10.3" y1="3.9" x2="4.7" y2="7.1" stroke="currentColor" strokeWidth="1.5"/>
                <line x1="4.7"  y1="8.9" x2="10.3" y2="12.1" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
              Share
            </button>
            <Link href="/board" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: C.sunken, color: C.secondary, border: `1px solid ${C.border}`, borderRadius: 11, padding: '11px 12px', font: `600 13px/1 'Instrument Sans', system-ui`, textDecoration: 'none' }}>
              {boardAirport} flights
              <svg width={12} height={12} viewBox="0 0 14 14" fill="none"><path d="M4 7h7M8 4l3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </Link>
          </div>

          {lastRefresh > 0 && (
            <div style={{ textAlign: 'center', paddingBottom: 10, fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.muted }}>
              Updated {new Date(lastRefresh).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

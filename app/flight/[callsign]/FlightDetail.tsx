'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { AIRLINE_LOGOS, LOGO_WHITE_BG } from '@/lib/airlines'
import { airportCity, airportFlag as apFlag, airportOffset, loadGeoData } from '@/lib/geo-data'

const cityOf = (iata: string) => airportCity[iata] ?? iata
const flagOf = (iata: string) => apFlag[iata] ?? ''
const tzOff  = (iata: string) => airportOffset[iata] ?? 3

const BLUE = '#3b82f6'

const C = {
  bg:     '#EDEBE0',
  card:   '#FFFFFF',
  times:  '#F0EEE3',
  ink:    '#111827',
  mid:    '#374151',
  muted:  '#6b7280',
  track:  '#D1D5DB',
  border: '#D8D3BF',
  forest: '#054239',
  goldenBg: '#fef3c7',
  goldenTx: '#92400e',
}

type StatusCfg = { label: string; bg: string; text: string }
const STATUS: Record<string, StatusCfg> = {
  Scheduled:   { label: 'Scheduled',   bg: '#1c1917', text: '#a8a29e' },
  Expected:    { label: 'Expected',    bg: '#713f12', text: '#fbbf24' },
  Boarding:    { label: 'Boarding',    bg: '#713f12', text: '#fbbf24' },
  GateClosed:  { label: 'Gate Closed', bg: '#713f12', text: '#fbbf24' },
  CheckIn:     { label: 'Check-in',    bg: '#713f12', text: '#fbbf24' },
  Departed:    { label: 'Departed',    bg: '#166534', text: '#4ade80' },
  'En Route':  { label: 'En route',    bg: '#166534', text: '#4ade80' },
  Approaching: { label: 'Approaching', bg: '#14532d', text: '#86efac' },
  Arrived:     { label: 'Arrived',     bg: '#1e3a5f', text: '#60a5fa' },
  Landed:      { label: 'Arrived',     bg: '#1e3a5f', text: '#60a5fa' },
  Cancelled:   { label: 'Cancelled',   bg: '#7f1d1d', text: '#f87171' },
  Delayed:     { label: 'Delayed',     bg: '#713f12', text: '#fbbf24' },
  Unknown:     { label: 'Unknown',     bg: '#1c1917', text: '#a8a29e' },
}

type Flight = {
  iata_number: string
  airline_name: string
  airline_iata: string
  airline_icao: string
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

function fmtNum(raw: string) {
  const m = raw.match(/^([A-Z]{2,3})(\d+.*)$/)
  return m ? `${m[1]} ${m[2]}` : raw
}

function durationLabel(min: number) {
  const h = Math.floor(min / 60), m = min % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function utcHHMMtoLocal(hhmm: string, offsetH: number) {
  if (!hhmm) return '—'
  const [h, m] = hhmm.slice(0, 5).split(':').map(Number)
  const t = ((h * 60 + m + Math.round(offsetH * 60)) % 1440 + 1440) % 1440
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

function isoToLocal(iso: string | null, offsetH: number) {
  if (!iso) return '—'
  const ms = new Date(iso).getTime() + Math.round(offsetH * 3_600_000)
  const d  = new Date(ms)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function calcDelayMin(schedHHMM: string, actualISO: string, date: string) {
  if (!actualISO || !schedHHMM) return 0
  const aMs = new Date(actualISO).getTime()
  let sMs   = new Date(`${date}T${schedHHMM}:00Z`).getTime()
  if (sMs - aMs > 12 * 3_600_000) sMs -= 86_400_000
  return Math.round((aMs - sMs) / 60_000)
}

function DelayBadge({ min }: { min: number }) {
  if (Math.abs(min) < 2) return null
  return (
    <span style={{ background: C.goldenBg, color: C.goldenTx, fontSize: 10, fontWeight: 700, padding: '2px 5px', borderRadius: 99, marginLeft: 5, lineHeight: 1.4 }}>
      {min > 0 ? `+${min}m` : `${min}m`}
    </span>
  )
}

function AirlineLogo({ iata, name }: { iata: string; name: string }) {
  const [src, setSrc]       = useState(AIRLINE_LOGOS[iata] ?? (iata ? `https://images.flightsfrom.com/airlines/100/${iata}_100px.png` : ''))
  const [failed, setFailed] = useState(!iata)
  const initials = iata.slice(0, 2).toUpperCase()
  if (failed || !src) return (
    <div style={{ width: 44, height: 44, borderRadius: 10, background: '#1f2937', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#9ca3af', fontFamily: 'monospace' }}>
      {initials}
    </div>
  )
  return (
    <img src={src} alt={name} width={44} height={44}
      style={{ width: 44, height: 44, borderRadius: 10, objectFit: 'contain', padding: 4, background: LOGO_WHITE_BG.has(iata) ? '#fff' : 'transparent', flexShrink: 0 }}
      onError={() => { if (src === AIRLINE_LOGOS[iata]) { setSrc(`https://images.flightsfrom.com/airlines/100/${iata}_100px.png`) } else { setFailed(true) } }} />
  )
}

// Plane-in-circle marker for the route bar
function PlanePin() {
  return (
    <div style={{
      width: 22, height: 22, borderRadius: '50%',
      background: BLUE, border: '2px solid #fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 1px 5px rgba(0,0,0,.22)',
      flexShrink: 0, pointerEvents: 'none',
    }}>
      <svg width={11} height={11} viewBox="0 0 24 24" fill="none">
        {/* Plane pointing right */}
        <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"
          fill="white" transform="rotate(90 12 12)" />
      </svg>
    </div>
  )
}

export default function FlightDetail({ callsign }: { callsign: string }) {
  const [flight, setFlight]   = useState<Flight | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [photo, setPhoto]     = useState<string | null>(null)
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

  // Photo: try registration → ICAO callsign → IATA callsign
  useEffect(() => {
    let cancelled = false
    async function fetchPhoto(f: Flight | null) {
      if (!f) return
      const digits = callsign.replace(/^[A-Z0-9]{2,3}/, '')

      // 1. If we have aircraft_reg, use it directly
      if (f.aircraft_reg) {
        const r = await fetch(`/api/photo/${encodeURIComponent(f.aircraft_reg)}`).catch(() => null)
        if (!cancelled && r?.ok) { const d = await r.json(); if (d?.url) { setPhoto(d.url); return } }
      }
      // 2. Try ICAO callsign (e.g. THY848 for TK848)
      if (f.airline_icao) {
        const icaoCs = f.airline_icao + digits
        const r = await fetch(`/api/photo-cs/${encodeURIComponent(icaoCs)}`).catch(() => null)
        if (!cancelled && r?.ok) { const d = await r.json(); if (d?.url) { setPhoto(d.url); return } }
      }
      // 3. Fallback: IATA callsign
      const r = await fetch(`/api/photo-cs/${encodeURIComponent(callsign)}`).catch(() => null)
      if (!cancelled && r?.ok) { const d = await r.json(); if (d?.url) setPhoto(d.url) }
    }
    fetchPhoto(flight)
    return () => { cancelled = true }
  }, [flight, callsign])

  const isCancelled = flight?.status === 'Cancelled'
  const isEnRoute   = flight && ['Departed', 'En Route', 'Approaching'].includes(flight.status)
  const isArrived   = flight && ['Arrived', 'Landed'].includes(flight.status)
  const statusCfg   = flight ? (STATUS[flight.status] ?? STATUS.Unknown) : null

  const depOffset = flight ? tzOff(flight.dep_iata) : 3
  const arrOffset = flight ? tzOff(flight.arr_iata) : 3

  const depDisplay = flight
    ? (flight.actual_dep_utc ? isoToLocal(flight.actual_dep_utc, depOffset) : utcHHMMtoLocal(flight.dep_time_utc, depOffset))
    : '—'
  const arrDisplay = flight
    ? (flight.actual_arr_utc ? isoToLocal(flight.actual_arr_utc, arrOffset)
      : flight.revised_arr_utc ? isoToLocal(flight.revised_arr_utc, arrOffset)
      : utcHHMMtoLocal(flight.arr_time_utc, arrOffset))
    : '—'

  const depDelay = flight?.actual_dep_utc ? calcDelayMin(flight.dep_time_utc, flight.actual_dep_utc, flight.date) : 0
  const arrDelay = flight?.actual_arr_utc ? calcDelayMin(flight.arr_time_utc, flight.actual_arr_utc, flight.date) : 0

  // En-route progress
  const progressPct = (() => {
    if (!isEnRoute || !flight?.actual_dep_utc || !flight.duration_min) return null
    const p = ((Date.now() - new Date(flight.actual_dep_utc).getTime()) / (flight.duration_min * 60_000)) * 100
    return Math.min(95, Math.max(3, p))
  })()

  const etaStr = (() => {
    if (!isEnRoute || progressPct == null || !flight?.duration_min) return ''
    const rem = Math.round(flight.duration_min * (1 - progressPct / 100))
    return rem >= 60 ? `${Math.floor(rem / 60)}h ${rem % 60}m left` : `${rem}m left`
  })()

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
    <div style={{ minHeight: '100dvh', background: C.bg, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 0 40px' }}>
      <style>{`* { box-sizing: border-box } @keyframes spin { to { transform: rotate(360deg) } }`}</style>

      {/* Back row */}
      <div style={{ width: '100%', maxWidth: 360, padding: '16px 16px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Link href="/board" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.border}`, background: C.card, color: C.ink, textDecoration: 'none', flexShrink: 0 }}>
          <svg width={13} height={13} viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </Link>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.muted }}>
          {flight ? fmtNum(flight.iata_number) : callsign.replace(/(\D+)(\d+)/, '$1 $2')}
        </span>
      </div>

      {loading && !flight && (
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
          <div style={{ width: 24, height: 24, border: `3px solid ${C.border}`, borderTopColor: C.forest, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        </div>
      )}

      {notFound && !flight && (
        <div style={{ textAlign: 'center', paddingTop: 60 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.ink, marginBottom: 8 }}>Flight not found</div>
          <div style={{ fontSize: 13, color: C.muted }}>No data for {fmtNum(callsign)} today or yesterday</div>
          <Link href="/board" style={{ display: 'inline-block', marginTop: 20, fontSize: 13, fontWeight: 600, color: C.forest, textDecoration: 'none' }}>← All flights</Link>
        </div>
      )}

      {/* ── Card ── */}
      {flight && statusCfg && (
        <div style={{ width: '100%', maxWidth: 360, margin: '0 16px', background: C.card, borderRadius: 16, overflow: 'hidden', border: `1px solid ${C.border}`, boxShadow: '0 4px 20px rgba(0,0,0,.09)' }}>

          {/* 1. Aircraft photo */}
          {photo && (
            <img src={photo} alt={flight.airline_name}
              style={{ width: '100%', height: 110, objectFit: 'cover', display: 'block' }} />
          )}

          {/* 2. Header: logo + airline + flight num + status */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '13px 13px 8px' }}>
            <AirlineLogo iata={flight.airline_iata} name={flight.airline_name} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, lineHeight: 1.25 }}>{flight.airline_name}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                {fmtNum(flight.iata_number)}{flight.aircraft_type ? ` · ${flight.aircraft_type}` : ''}
              </div>
            </div>
            <span style={{ background: statusCfg.bg, color: statusCfg.text, fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 99, flexShrink: 0, marginTop: 1 }}>
              {statusCfg.label}
            </span>
          </div>

          {/* 3. Route progress */}
          <div style={{ padding: '2px 14px 14px' }}>

            {/* ETA (en route) or duration (arrived) */}
            {isEnRoute && etaStr && (
              <div style={{ textAlign: 'center', color: C.muted, fontSize: 11, marginBottom: 6 }}>{etaStr}</div>
            )}
            {isArrived && flight.duration_min > 0 && (
              <div style={{ textAlign: 'center', color: C.muted, fontSize: 11, marginBottom: 6 }}>{durationLabel(flight.duration_min)}</div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {/* DEP — bordered frame */}
              <div style={{ flexShrink: 0, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 8px', background: C.bg, minWidth: 64 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.mid, whiteSpace: 'nowrap' }}>{flagOf(flight.dep_iata)} {cityOf(flight.dep_iata)}</div>
                <div style={{ fontSize: 10, color: C.muted, fontFamily: 'monospace', marginTop: 1 }}>{flight.dep_iata}</div>
              </div>

              {/* Bar + plane */}
              <div style={{ flex: 1, position: 'relative', height: 3, background: C.track, borderRadius: 2 }}>
                {/* Blue fill */}
                <div style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 2,
                  background: BLUE,
                  width: isArrived ? '100%' : isEnRoute && progressPct != null ? `${progressPct}%` : '0%',
                }} />
                {/* Scheduled/pre-departure: plane sits at the start */}
                {!isEnRoute && !isArrived && (
                  <div style={{ position: 'absolute', top: '50%', left: -11, transform: 'translateY(-50%)', zIndex: 2 }}>
                    <PlanePin />
                  </div>
                )}
                {/* En route: plane at progress position */}
                {isEnRoute && progressPct != null && (
                  <div style={{ position: 'absolute', top: '50%', left: `${progressPct}%`, transform: 'translate(-50%, -50%)', zIndex: 2 }}>
                    <PlanePin />
                  </div>
                )}
                {/* Arrived: plane at far right */}
                {isArrived && (
                  <div style={{ position: 'absolute', top: '50%', right: -11, transform: 'translateY(-50%)', zIndex: 2 }}>
                    <PlanePin />
                  </div>
                )}
              </div>

              {/* ARR — bordered frame */}
              <div style={{ flexShrink: 0, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 8px', background: C.bg, minWidth: 64, textAlign: 'right' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.mid, whiteSpace: 'nowrap' }}>{cityOf(flight.arr_iata)} {flagOf(flight.arr_iata)}</div>
                <div style={{ fontSize: 10, color: C.muted, fontFamily: 'monospace', marginTop: 1 }}>{flight.arr_iata}</div>
              </div>
            </div>
          </div>

          {/* 4. Times */}
          <div style={{ display: 'flex', background: C.times, padding: '11px 14px', borderTop: `1px solid ${C.border}` }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 9, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 3 }}>Departure</div>
              <div style={{ display: 'flex', alignItems: 'baseline' }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: isCancelled ? C.muted : C.ink, fontVariantNumeric: 'tabular-nums', textDecoration: isCancelled ? 'line-through' : 'none' }}>
                  {depDisplay}
                </span>
                {!isCancelled && <DelayBadge min={depDelay} />}
              </div>
            </div>
            <div style={{ flex: 1, textAlign: 'right' }}>
              <div style={{ fontSize: 9, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 3 }}>Arrival</div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end' }}>
                {!isCancelled && <DelayBadge min={arrDelay} />}
                <span style={{ fontSize: 20, fontWeight: 700, color: isCancelled ? C.muted : C.ink, fontVariantNumeric: 'tabular-nums', textDecoration: isCancelled ? 'line-through' : 'none' }}>
                  {arrDisplay}
                </span>
              </div>
            </div>
          </div>

          {/* 5. Actions */}
          <div style={{ display: 'flex', gap: 8, padding: '10px 13px 13px' }}>
            {/* Share */}
            <button onClick={handleShare} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: C.forest, color: '#fff', border: 'none', borderRadius: 10, padding: '10px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              <svg width={12} height={12} viewBox="0 0 16 16" fill="none">
                <circle cx="12" cy="3"  r="1.8" stroke="currentColor" strokeWidth="1.5"/>
                <circle cx="12" cy="13" r="1.8" stroke="currentColor" strokeWidth="1.5"/>
                <circle cx="3"  cy="8"  r="1.8" stroke="currentColor" strokeWidth="1.5"/>
                <line x1="10.3" y1="3.9" x2="4.7" y2="7.1" stroke="currentColor" strokeWidth="1.5"/>
                <line x1="4.7"  y1="8.9" x2="10.3" y2="12.1" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
              Share
            </button>
            {/* Track → FR24 live map */}
            <a
              href={`https://www.flightradar24.com/${flight.iata_number}`}
              target="_blank" rel="noopener noreferrer"
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: '#EBF3EF', color: C.forest, border: `1px solid #B8D8CC`, borderRadius: 10, padding: '10px 8px', fontSize: 12, fontWeight: 600, textDecoration: 'none' }}
            >
              <svg width={12} height={12} viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="6.5" r="3" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M8 15C8 15 2.5 10 2.5 6.5a5.5 5.5 0 0 1 11 0C13.5 10 8 15 8 15z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
              </svg>
              Track
            </a>
            {/* Airport board */}
            <Link href="/board" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: '#F7F5EC', color: C.ink, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 8px', fontSize: 12, fontWeight: 600, textDecoration: 'none' }}>
              {boardAirport}
              <svg width={11} height={11} viewBox="0 0 14 14" fill="none"><path d="M4 7h7M8 4l3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </Link>
          </div>

          {lastRefresh > 0 && (
            <div style={{ textAlign: 'center', paddingBottom: 10, fontSize: 9, color: C.muted, fontFamily: 'monospace' }}>
              Updated {new Date(lastRefresh).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

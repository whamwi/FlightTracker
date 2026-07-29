'use client'

import { useEffect, useState, useCallback, useRef, Fragment } from 'react'
import Link from 'next/link'
import { AIRLINE_LOGOS, LOGO_WHITE_BG } from '@/lib/airlines'
import { airportCity, airportFlag as _apFlag, airportOffset, loadGeoData } from '@/lib/geo-data'

const city = (iata: string) => airportCity[iata] ?? iata
const airportFlag = (iata: string) => _apFlag[iata] ?? ''

// ── Palette ──────────────────────────────────────────────────────────────────
const C = {
  bg:         '#EDEBE0',
  surface:    '#FFFFFF',
  sunken:     '#F7F5EC',
  ink:        '#161616',
  secondary:  '#3D3A3B',
  muted:      '#8A8578',
  border:     '#D8D3BF',
  separator:  '#CFC9B2',
  trackEmpty: '#E0DCCB',
  forest:     '#054239',
  forestMid:  '#428177',
  forestLight:'#9EBFB8',
  golden:     '#988561',
  goldenBg:   '#F3EFE0',
  goldenBdr:  '#DFD3B4',
  goldenText: '#6E5F3C',
  wine:       '#6B1F2A',
  wineBg:     '#F1E6E7',
  wineText:   '#6B1F2A',
}

// ── Status config ─────────────────────────────────────────────────────────────
type StatusCfg = {
  label: string
  bg: string
  text: string
  dot?: string
  border?: string
  rail: string
  strikethrough?: boolean
}

const STATUS: Record<string, StatusCfg> = {
  Scheduled:   { label: 'Scheduled',   bg: '#F7F5EC', text: C.muted,      rail: C.border },
  Expected:    { label: 'Expected',    bg: C.goldenBg, text: C.goldenText, dot: C.golden,    border: C.goldenBdr, rail: C.golden },
  CheckIn:     { label: 'Check-in',   bg: C.goldenBg, text: C.goldenText, dot: C.golden,    border: C.goldenBdr, rail: C.golden },
  Boarding:    { label: 'Boarding',   bg: C.goldenBg, text: C.goldenText, dot: C.golden,    border: C.goldenBdr, rail: C.golden },
  GateClosed:  { label: 'Gate Closed',bg: C.goldenBg, text: C.goldenText, dot: C.golden,    border: C.goldenBdr, rail: C.golden },
  Departed:    { label: 'Departed',   bg: C.forestMid, text: '#fff',      dot: '#fff',                           rail: C.forestMid },
  'En Route':  { label: 'En route',   bg: C.forestMid, text: '#fff',      dot: '#fff',                           rail: C.forestMid },
  Approaching: { label: 'Approaching',bg: C.forest,   text: '#EDEBE0',   dot: '#EDEBE0',                        rail: C.forestMid },
  Arrived:     { label: 'Arrived',    bg: '#E6EFEC',  text: '#002623',   dot: C.forest,    border: '#B4CFC9',   rail: C.forestLight },
  Landed:      { label: 'Arrived',    bg: '#E6EFEC',  text: '#002623',   dot: C.forest,    border: '#B4CFC9',   rail: C.forestLight },
  Cancelled:   { label: 'Cancelled',  bg: C.wine,     text: '#fff',                                             rail: C.wine, strikethrough: true },
  Diverted:    { label: 'Diverted',   bg: '#7f3100',  text: '#fff',                                             rail: '#7f3100' },
  Delayed:     { label: 'Delayed',    bg: C.goldenBg, text: C.goldenText, dot: C.golden,    border: C.goldenBdr, rail: C.golden },
  Unknown:     { label: 'Unknown',    bg: '#E4E1D2',  text: C.muted,                                            rail: C.border },
}

const STATUS_ALIAS: Record<string, string> = { Landed: 'Arrived', Land: 'Arrived' }

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

type Tab     = -1 | 0 | 1
type View    = 'arr' | 'dep'
type Airport = 'DAM' | 'ALP'

// ── Helpers ──────────────────────────────────────────────────────────────────
function syriaDate(offsetDays: number): string {
  const ms = Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

function tzOffset(iata: string): number { return airportOffset[iata] ?? 3 }

function utcHHMMtoLocal(hhmm: string, offsetH: number): string {
  const [h, m] = hhmm.slice(0, 5).split(':').map(Number)
  const total = ((h * 60 + m + Math.round(offsetH * 60)) % 1440 + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

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
  if (f.actual_arr_utc) return 'Arrived'
  if (s === 'Arrived' || s === 'Landed' || s === 'Cancelled' || s === 'Diverted') return s
  if (f.actual_dep_utc) {
    const actMs = new Date(f.actual_dep_utc).getTime()
    if (f.duration_min && actMs + f.duration_min * 60_000 < Date.now() - 15 * 60_000) return 'Arrived'
    return s !== 'Unknown' ? s : 'Departed'
  }
  if (f.revised_arr_utc && (s === 'Scheduled' || s === 'Unknown')) return 'Expected'
  return s
}

function computedETA(f: Flight): string | null {
  if (!f.actual_dep_utc || !f.duration_min) return null
  if (f.actual_arr_utc || f.revised_arr_utc) return null
  const ms = new Date(f.actual_dep_utc).getTime() + f.duration_min * 60_000
  return new Date(ms).toISOString()
}

function calcDelay(schedHHMM: string, actualISO: string | null): number | null {
  if (!actualISO || !schedHHMM) return null
  const opDate   = actualISO.slice(0, 10)
  const actualMs = new Date(actualISO).getTime()
  let   schedMs  = new Date(`${opDate}T${schedHHMM}:00Z`).getTime()
  if (schedMs - actualMs > 12 * 3_600_000) schedMs -= 86_400_000
  return Math.round((actualMs - schedMs) / 60_000)
}

function effectiveLocalMin(f: Flight, v: View): number {
  const iso = v === 'arr'
    ? (f.actual_arr_utc ?? f.revised_arr_utc)
    : (f.actual_dep_utc ?? f.revised_dep_utc)
  if (iso) {
    const localMs = new Date(iso).getTime() + 3 * 3_600_000
    const d = new Date(localMs)
    return d.getUTCHours() * 60 + d.getUTCMinutes()
  }
  const hhmm = v === 'arr' ? f.arr_time_utc : f.dep_time_utc
  if (!hhmm) return 0
  const [h, m] = hhmm.split(':').map(Number)
  return (h * 60 + m + 3 * 60) % 1440
}

// ── Airline logo ─────────────────────────────────────────────────────────────
function AirlineLogo({ iata, name }: { iata: string; name: string }) {
  const initials = iata.slice(0, 2).toUpperCase()
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
    return (
      <div style={{
        width: 38, height: 38, borderRadius: 10, background: '#E4E1D2',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: C.muted, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 700,
        flexShrink: 0,
      }}>
        {initials}
      </div>
    )
  }

  return (
    <div style={{
      width: 38, height: 38, borderRadius: 10, overflow: 'hidden', flexShrink: 0,
      background: LOGO_WHITE_BG.has(iata) ? '#fff' : '#F7F5EC',
      border: `1px solid ${C.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <img
        src={src} alt={name} title={name}
        width={38} height={38}
        style={{ objectFit: 'contain', width: 38, height: 38 }}
        onError={handleError}
      />
    </div>
  )
}

// ── Progress route (en-route) ────────────────────────────────────────────────
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
  const fill  = Math.max(1, pct)
  const empty = Math.max(1, 100 - pct)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: C.muted, whiteSpace: 'nowrap' }}>
        {remainingMin > 0 ? `${durationLabel(remainingMin)} left` : 'Arriving'}
      </span>
      <div style={{ display: 'flex', flexDirection: 'row', width: '100%', alignItems: 'center', height: 20 }}>
        <div style={{ flex: fill, height: 4, borderRadius: 99, background: C.forestMid }} />
        <div style={{
          width: 18, height: 18, borderRadius: 9, background: C.surface, flexShrink: 0,
          border: `1.5px solid ${C.forestMid}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: `0 2px 5px rgba(66,129,119,.35)`,
        }}>
          <svg width="9" height="9" viewBox="0 0 10 10" fill={C.forestMid}><path d="M.7 1.1 9.3 5 .7 8.9 2.5 5z"/></svg>
        </div>
        <div style={{ flex: empty, height: 4, borderRadius: 99, background: C.trackEmpty }} />
      </div>
    </div>
  )
}

// ── Arrived route ─────────────────────────────────────────────────────────────
function ArrivedRoute({ durationMin }: { durationMin: number }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      {durationMin > 0 && (
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: C.muted, whiteSpace: 'nowrap' }}>
          {durationLabel(durationMin)}
        </span>
      )}
      <div style={{ display: 'flex', flexDirection: 'row', width: '100%', alignItems: 'center', height: 20 }}>
        <div style={{ flex: 1, height: 4, borderRadius: 99, background: C.forestLight, position: 'relative' }}>
          <div style={{ position: 'absolute', inset: 0, background: C.forestLight, borderRadius: 99 }} />
        </div>
        <div style={{
          width: 18, height: 18, borderRadius: 9, background: C.surface, flexShrink: 0,
          border: `1.5px solid ${C.forestLight}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 5px rgba(22,22,22,.12)',
        }}>
          <svg width="9" height="9" viewBox="0 0 10 10" fill={C.forest} style={{ transform: 'rotate(45deg)' }}><path d="M.7 1.1 9.3 5 .7 8.9 2.5 5z"/></svg>
        </div>
      </div>
    </div>
  )
}

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status, view }: { status: string; view?: View }) {
  const cfg = (() => {
    if (view === 'dep' && status === 'Departed') {
      return { ...STATUS.Departed, bg: '#E6EFEC', text: '#002623', dot: C.forest, border: '#B4CFC9' }
    }
    return STATUS[status] ?? STATUS.Unknown
  })()
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
      padding: cfg.dot ? '5px 11px 5px 9px' : '5px 11px',
      borderRadius: 999, background: cfg.bg,
      border: cfg.border ? `1px solid ${cfg.border}` : undefined,
    }}>
      {cfg.dot && <span style={{ width: 6, height: 6, borderRadius: 99, background: cfg.dot, display: 'block', flexShrink: 0 }} />}
      <span style={{ font: `600 11.5px/1 'Instrument Sans', system-ui`, color: cfg.text, whiteSpace: 'nowrap' }}>
        {cfg.label}
      </span>
    </div>
  )
}

// ── Delay chip ────────────────────────────────────────────────────────────────
function DelayChip({ min }: { min: number | null }) {
  if (!min || Math.abs(min) < 1) return null
  const isLate = min > 0
  return (
    <span style={{
      fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600,
      padding: '3px 5px', borderRadius: 5, lineHeight: 1,
      background: isLate ? C.wineBg : '#E6EFEC',
      color: isLate ? C.wineText : '#002623',
    }}>
      {isLate ? `+${min}m` : `${min}m`}
    </span>
  )
}

// ── WhatsApp SVG ──────────────────────────────────────────────────────────────
const WhatsAppSVG = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#1E8E4C" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.6 20.4 5 16.2A8.2 8.2 0 1 1 7.9 19z"/>
    <path d="M8.9 8.6c.4 1.9 2.4 3.9 4.3 4.3l.9-1.2 1.9.9-.2 1.5c-3 .6-6.9-2.7-7.5-5.6l1.5-.3z"/>
  </svg>
)

const PinSVG = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 17v5"/>
    <path d="M9 10.8V4h6v6.8a2 2 0 0 0 .55 1.38l1.9 2a1 1 0 0 1-.72 1.7H6.27a1 1 0 0 1-.72-1.7l1.9-2A2 2 0 0 0 8 10.8"/>
  </svg>
)

// ── Flight card ───────────────────────────────────────────────────────────────
function FlightCard({ f, view }: { f: Flight; view: View }) {
  const isArr   = view === 'arr'
  const status  = effectiveStatus(f)
  const cfg     = STATUS[status] ?? STATUS.Unknown
  const isCancelled = status === 'Cancelled'

  const depOff = isArr ? tzOffset(f.dep_iata) : 3
  const arrOff = isArr ? 3 : tzOffset(f.arr_iata)

  const depTime = fmtLocal(f.actual_dep_utc ?? f.revised_dep_utc ?? f.dep_time_utc, depOff)
  const arrTime = fmtLocal(f.actual_arr_utc ?? f.revised_arr_utc ?? f.arr_time_utc, arrOff)

  const depDelay = calcDelay(f.dep_time_utc, f.actual_dep_utc ?? f.revised_dep_utc)
  const arrDelay = calcDelay(f.arr_time_utc, f.actual_arr_utc ?? f.revised_arr_utc)

  const hasActualDep = !!f.actual_dep_utc
  const hasActualArr = !!f.actual_arr_utc
  const hasEstArr    = !!f.revised_arr_utc && !hasActualArr
  const hasComputedETA = !!computedETA(f) && !hasActualArr && !hasEstArr

  const depForProgress = f.actual_dep_utc ?? f.revised_dep_utc
    ?? (f.sched_dep_unix ? new Date(f.sched_dep_unix * 1000).toISOString() : null)
  const showProgress = (status === 'Departed' || status === 'En Route' || status === 'Approaching')
    && !!depForProgress && f.duration_min > 0 && !f.actual_arr_utc
  const showArrived  = status === 'Arrived' && f.duration_min > 0

  const depTimeColor = hasActualDep ? C.ink : f.revised_dep_utc ? C.goldenText : C.ink
  const arrTimeColor = hasActualArr ? C.ink : hasEstArr ? C.goldenText : C.ink

  const showTrack = showProgress

  return (
    <div style={{
      position: 'relative',
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 16,
      overflow: 'hidden',
      boxShadow: isCancelled ? 'none' : '0 1px 2px rgba(22,22,22,.05), 0 12px 26px -22px rgba(22,22,22,.5)',
      opacity: isCancelled ? 0.72 : 1,
    }}>
      {/* Status rail */}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: cfg.rail, zIndex: 1 }} />

      {/* Header */}
      <div style={{ padding: '14px 16px 13px 20px', display: 'flex', alignItems: 'center', gap: 11 }}>
        <AirlineLogo iata={f.airline_iata} name={f.airline_name} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{
            font: `600 14.5px/1.1 'Instrument Sans', system-ui`, color: C.ink,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            textDecoration: isCancelled ? 'line-through' : 'none',
            textDecorationColor: '#C4BEAE',
          }}>
            {f.airline_name}
          </span>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.muted, letterSpacing: '.07em' }}>
            {f.iata_number}{f.aircraft_type ? ` · ${f.aircraft_type}` : ''}
          </span>
        </div>

        <StatusBadge status={status} view={view} />

        {showTrack && (
          <Link href="/" style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px 7px 10px',
            borderRadius: 9, background: C.forest, textDecoration: 'none',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <g transform="translate(1.6 -1) scale(0.86)"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></g>
              <path d="M2.2 21.6c1.6-1.7 3.4-3.2 5.5-4.4" strokeDasharray="2.3 2.5"/>
            </svg>
            <span style={{ font: `600 12px/1 'Instrument Sans', system-ui`, color: '#fff' }}>Track</span>
          </Link>
        )}

        <div className="ft-card-actions" style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 12, marginLeft: 2, borderLeft: `1px solid ${C.trackEmpty}` }}>
          <button title="Pin flight" style={{
            width: 30, height: 30, borderRadius: 9, background: C.sunken, border: `1px solid ${C.trackEmpty}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}>
            <PinSVG />
          </button>
          <button title="Send on WhatsApp" style={{
            width: 30, height: 30, borderRadius: 9, background: '#E9F5EC', border: '1px solid #C9E6D3',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}>
            <WhatsAppSVG />
          </button>
        </div>
      </div>

      {/* Footer */}
      <div style={{ borderTop: `1px dashed ${C.separator}`, background: C.sunken, padding: '13px 16px 15px 20px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>

        {/* Dep */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 118, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 14 }}>{airportFlag(f.dep_iata)}</span>
            <span style={{ font: `600 13.5px/1.1 'Instrument Sans', system-ui`, color: isCancelled ? C.secondary : C.ink, whiteSpace: 'nowrap' }}>
              {city(f.dep_iata)}
            </span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: C.muted, letterSpacing: '.06em' }}>{f.dep_iata}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{
              font: `600 20px/1 'IBM Plex Mono', monospace`,
              color: isCancelled ? '#A6A093' : depTimeColor,
              textDecoration: isCancelled ? 'line-through' : 'none',
            }}>
              {depTime}
            </span>
            {!isCancelled && <DelayChip min={depDelay} />}
          </div>
        </div>

        {/* Middle: track */}
        {isCancelled ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 5 }}>
            <span style={{ font: `500 11px/1 'Instrument Sans', system-ui`, color: C.muted, textAlign: 'center' }}>
              Cancelled
            </span>
          </div>
        ) : showProgress && depForProgress ? (
          <ProgressRoute depUtc={depForProgress} durationMin={f.duration_min} />
        ) : showArrived ? (
          <ArrivedRoute durationMin={f.duration_min} />
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, paddingTop: 5 }}>
            {f.duration_min > 0 && (
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: C.muted, whiteSpace: 'nowrap' }}>
                {durationLabel(f.duration_min)}
              </span>
            )}
            <div style={{ width: '100%', height: 4, borderRadius: 99, background: C.trackEmpty }} />
            {(isArr ? f.arr_gate : f.dep_gate) && (
              <span style={{ font: `600 10.5px/1 'Instrument Sans', system-ui`, color: C.goldenText }}>
                Gate {isArr ? f.arr_gate : f.dep_gate}
              </span>
            )}
          </div>
        )}

        {/* Arr */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 118, alignItems: 'flex-end', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ font: `600 13.5px/1.1 'Instrument Sans', system-ui`, color: isCancelled ? C.secondary : C.ink, whiteSpace: 'nowrap' }}>
              {city(f.arr_iata)}
            </span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: C.muted, letterSpacing: '.06em' }}>{f.arr_iata}</span>
            <span style={{ fontSize: 14 }}>{airportFlag(f.arr_iata)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            {!isCancelled && isArr && <DelayChip min={arrDelay} />}
            {hasEstArr && !isCancelled && (
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, padding: '3px 5px', borderRadius: 5, background: C.goldenBg, color: C.goldenText }}>est.</span>
            )}
            {hasComputedETA && !isCancelled && (
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, padding: '3px 5px', borderRadius: 5, background: C.goldenBg, color: C.goldenText }}>~</span>
            )}
            <span style={{
              font: `600 20px/1 'IBM Plex Mono', monospace`,
              color: isCancelled ? '#A6A093' : arrTimeColor,
              textDecoration: isCancelled ? 'line-through' : 'none',
            }}>
              {hasComputedETA && !isCancelled ? fmtLocal(computedETA(f), arrOff) : arrTime}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Tab date label ────────────────────────────────────────────────────────────
function tabDateLabel(offset: number): string {
  const d = syriaDate(offset)
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// ── Plane SVG ─────────────────────────────────────────────────────────────────
const LogoPlane = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#EDEBE0" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 22h20"/>
    <path d="M6.36 17.4 4 17l-2-4 1.1-.55a2 2 0 0 1 1.8 0l.7.35 1.7-3.4 1.9-.95a2 2 0 0 1 1.8 0l.7.35"/>
    <path d="m14.5 12.5 2.5-5.5a2 2 0 0 1 1.5-1.1l2.9-.5a1 1 0 0 1 1.1 1.3l-1.1 3a2 2 0 0 1-1.1 1.2L6.4 17.4"/>
  </svg>
)

// ── Main page ─────────────────────────────────────────────────────────────────
export default function BoardPage() {
  const [tab, setTab]         = useState<Tab>(0)
  const [view, setView]       = useState<View>('arr')
  const [airport, setAirport] = useState<Airport>('DAM')
  const [flights, setFlights] = useState<Flight[]>([])
  const [loading, setLoading] = useState(true)
  const [date, setDate]       = useState('')

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
        const writes = Object.entries(byDate).map(([d, v]) =>
          fetch('/api/fr24-cache', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ airport_iata: airportCode, flight_date: d, ...v }) }).catch(() => {})
        )
        if (depth === 0) {
          Promise.all(writes).then(() => loadRef.current(0, true)).catch(() => {})
        }
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

  useEffect(() => { loadGeoData() }, [])
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

  useEffect(() => {
    warmFR24Cache('DAM')
    warmFR24Cache('ALP')
  }, [warmFR24Cache])

  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    warmFR24Cache(airport)
    const timer = setTimeout(() => load(tab, true), 4000)
    return () => clearTimeout(timer)
  }, [airport]) // eslint-disable-line react-hooks/exhaustive-deps

  const byViewAndAirport = (() => {
    if (view === 'dep') return flights.filter(f => f.dep_iata === airport)
    return flights.filter(f => f.arr_iata === airport)
  })()

  const sorted = [...byViewAndAirport]
    .filter(f => effectiveStatus(f) !== 'Unknown')
    .sort((a, b) => effectiveLocalMin(a, view) - effectiveLocalMin(b, view))

  const total     = sorted.length
  const landed    = sorted.filter(f => ['Arrived', 'Landed'].includes(effectiveStatus(f))).length
  const cancelled = sorted.filter(f => effectiveStatus(f) === 'Cancelled').length
  const enroute   = sorted.filter(f => ['En Route', 'Departed', 'Approaching'].includes(effectiveStatus(f))).length

  const nowSyriaHHMM = (() => {
    const d = new Date(Date.now() + 3 * 3_600_000)
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  })()

  const nowSyriaMin = Math.floor((Date.now() + 3 * 3_600_000) / 60_000) % 1440
  const nowIdx = tab === 0
    ? sorted.findIndex(f => effectiveLocalMin(f, view) >= nowSyriaMin)
    : -1

  const dateLabel = date
    ? new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    : ''

  const airportLabel = airport === 'DAM' ? 'Damascus International · DAM' : 'Aleppo International · ALP'
  const viewTitle    = view === 'arr' ? 'Arrivals' : 'Departures'
  const tabTitle     = tab === 0 ? 'today' : tab === -1 ? 'yesterday' : 'tomorrow'

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: "'Instrument Sans', system-ui, sans-serif" }}>
      <style>{`
        .ft-nav { padding: 0 16px !important; gap: 12px !important; height: 56px !important; }
        .ft-nav-tabs { display: none !important; }
        .ft-search { display: none !important; }
        .ft-body { padding: 16px 16px 32px !important; flex-direction: column !important; }
        .ft-title { font-size: 26px !important; }
        .ft-sidebar { display: none !important; }
        .ft-controls { gap: 8px !important; flex-wrap: wrap !important; }
        .ft-airport-btn { padding: 8px 14px !important; }
        .ft-card-actions { display: none !important; }
        .ft-body { align-items: stretch !important; }
        @media (min-width: 768px) {
          .ft-nav { padding: 0 28px !important; gap: 20px !important; height: 68px !important; }
          .ft-nav-tabs { display: flex !important; }
          .ft-search { display: flex !important; }
          .ft-body { padding: 26px 28px 40px !important; flex-direction: row !important; }
          .ft-title { font-size: 34px !important; }
          .ft-sidebar { display: flex !important; flex-direction: column; gap: 16px; width: 300px; flex-shrink: 0; }
          .ft-controls { gap: 12px !important; }
          .ft-airport-btn { padding: 8px 32px !important; }
          .ft-card-actions { display: flex !important; }
          .ft-body { align-items: flex-start !important; }
        }
        @media (min-width: 1100px) {
          .ft-nav { padding: 0 40px !important; }
          .ft-body { padding: 26px 40px 40px !important; }
          .ft-sidebar { width: 320px; }
        }
      `}</style>

      {/* ── Nav bar ── */}
      <div className="ft-nav" style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', position: 'sticky', top: 0, zIndex: 20 }}>

        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: C.forest, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <LogoPlane />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ font: `700 16px/1 'Instrument Sans', system-ui`, color: C.ink, letterSpacing: '-.01em' }}>FlySyria Tracker</span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.muted, letterSpacing: '.1em' }}>DAM · ALP</span>
          </div>
        </div>

        {/* Nav tabs — desktop only */}
        <div className="ft-nav-tabs" style={{ alignItems: 'center', gap: 4, marginLeft: 14 }}>
          {[
            { label: 'Flights', active: true },
            { label: 'Track',   active: false },
            { label: 'Destinations', active: false },
            { label: 'Airlines', active: false },
          ].map(item => (
            <div key={item.label} style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '9px 14px', borderRadius: 10,
              background: item.active ? C.sunken : 'transparent',
            }}>
              <span style={{ font: `${item.active ? 700 : 600} 13.5px/1 'Instrument Sans', system-ui`, color: item.active ? C.forest : C.secondary }}>
                {item.label}
              </span>
            </div>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {/* Search — desktop only */}
        <div className="ft-search" style={{
          width: 260, height: 38, borderRadius: 10, background: C.sunken, border: `1px solid ${C.border}`,
          alignItems: 'center', gap: 9, padding: '0 12px',
        }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.9" strokeLinecap="round">
            <circle cx="11" cy="11" r="7"/><path d="m20 20-4.3-4.3"/>
          </svg>
          <span style={{ font: `500 12.5px/1 'Instrument Sans', system-ui`, color: C.muted }}>Flight number, city or airline</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, color: '#A6A093', background: C.bg, padding: '3px 5px', borderRadius: 4 }}>⌘K</span>
        </div>

        {/* LIVE indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderRadius: 10, background: C.sunken, border: `1px solid ${C.border}`, flexShrink: 0 }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: C.forestMid, display: 'block' }} />
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600, color: C.secondary, whiteSpace: 'nowrap' }}>
            LIVE {nowSyriaHHMM}
          </span>
        </div>
      </div>

      {/* ── Main body ── */}
      <div className="ft-body" style={{ maxWidth: 1400, margin: '0 auto', display: 'flex', gap: 20, alignItems: 'flex-start' }}>

        {/* ── Left: flight list ── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Title + controls */}
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <span style={{ font: `500 12px/1 'Instrument Sans', system-ui`, color: C.muted, letterSpacing: '.02em' }}>{airportLabel}</span>
              <h1 className="ft-title" style={{ margin: 0, font: `700 34px/1 'Instrument Sans', system-ui`, color: C.ink, letterSpacing: '-.025em' }}>
                {viewTitle} {tabTitle}
              </h1>
            </div>
          </div>

          {/* Controls row */}
          <div className="ft-controls" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Date tabs */}
            <div style={{ display: 'flex', gap: 6 }}>
              {([-1, 0, 1] as Tab[]).map(t => (
                <button key={t} onClick={() => setTab(t)} style={{
                  padding: '9px 14px 10px', borderRadius: 12, cursor: 'pointer',
                  background: tab === t ? C.ink : C.surface,
                  border: tab === t ? 'none' : `1px solid ${C.border}`,
                  display: 'flex', alignItems: 'baseline', gap: 7,
                  boxShadow: tab === t ? '0 8px 18px -10px rgba(22,22,22,.55)' : 'none',
                }}>
                  <span style={{ font: `${tab === t ? 700 : 600} 13px/1 'Instrument Sans', system-ui`, color: tab === t ? '#fff' : C.secondary }}>
                    {t === -1 ? 'Yesterday' : t === 0 ? `Today · ${tabDateLabel(0)}` : 'Tomorrow'}
                  </span>
                  {tab === t && total > 0 && (
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, fontWeight: 600, background: '#B9A779', color: C.ink, padding: '3px 5px', borderRadius: 5 }}>
                      {total}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Arr / Dep + DAM / ALP */}
            <div style={{ display: 'flex', padding: 3, background: C.border, borderRadius: 11, gap: 3 }}>
              {(['arr', 'dep'] as View[]).map(v => (
                <button key={v} onClick={() => setView(v)} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 9, cursor: 'pointer',
                  background: view === v ? C.surface : 'transparent',
                  border: 'none',
                  boxShadow: view === v ? '0 1px 3px rgba(22,22,22,.14)' : 'none',
                }}>
                  <span style={{ font: `600 13px/1 'Instrument Sans', system-ui`, color: view === v ? C.ink : C.muted }}>
                    {v === 'arr' ? 'Arrivals' : 'Departures'}
                  </span>
                  {view === v && (
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, fontWeight: 600, color: C.forest, background: '#E6EFEC', padding: '2px 5px', borderRadius: 5 }}>
                      {total}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', padding: 3, background: C.border, borderRadius: 11, gap: 3 }}>
              {(['DAM', 'ALP'] as Airport[]).map(ap => (
                <button key={ap} onClick={() => setAirport(ap)} className="ft-airport-btn" style={{
                  padding: '8px 32px', borderRadius: 9, cursor: 'pointer',
                  background: airport === ap ? C.forest : 'transparent',
                  border: 'none',
                  fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 700,
                  color: airport === ap ? '#fff' : C.muted,
                  letterSpacing: '.07em',
                }}>
                  {ap}
                </button>
              ))}
            </div>
          </div>

          {/* Loading */}
          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 0', gap: 12 }}>
              <div style={{ width: 32, height: 32, border: `2px solid ${C.forestMid}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              <p style={{ color: C.muted, fontSize: 14, margin: 0 }}>Loading flights…</p>
              <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
            </div>
          )}

          {/* Empty */}
          {!loading && sorted.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 0', gap: 8, textAlign: 'center' }}>
              <span style={{ fontSize: 48 }}>✈</span>
              <p style={{ color: C.secondary, fontWeight: 600, margin: 0 }}>No {view === 'arr' ? 'arrivals' : 'departures'}</p>
              <p style={{ color: C.muted, fontSize: 14, margin: 0 }}>{airport} · {dateLabel}</p>
            </div>
          )}

          {/* Flight cards */}
          {!loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {sorted.map((f, i) => (
                <Fragment key={`${f.iata_number}-${f.dep_iata}-${f.arr_iata}-${f.dep_time_utc}-${f.arr_time_utc}`}>
                  {i === nowIdx && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '2px 0' }}>
                      <div style={{ flex: 1, height: 1, background: C.separator }} />
                      {landed > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px 5px 9px', borderRadius: 999, background: '#E6EFEC', border: '1px solid #B4CFC9' }}>
                          <span style={{ width: 6, height: 6, borderRadius: 99, background: C.forest, display: 'block' }} />
                          <span style={{ font: `600 11.5px/1 'Instrument Sans', system-ui`, color: '#002623', whiteSpace: 'nowrap' }}>
                            {landed} {view === 'arr' ? 'arrived' : 'departed'}
                          </span>
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 999, background: C.ink }}>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, fontWeight: 600, color: '#fff', letterSpacing: '.04em' }}>
                          {nowSyriaHHMM} NOW
                        </span>
                      </div>
                      {enroute > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px 5px 9px', borderRadius: 999, background: C.forestMid }}>
                          <span style={{ width: 6, height: 6, borderRadius: 99, background: '#fff', display: 'block' }} />
                          <span style={{ font: `600 11.5px/1 'Instrument Sans', system-ui`, color: '#fff', whiteSpace: 'nowrap' }}>
                            {enroute} in air
                          </span>
                        </div>
                      )}
                      <div style={{ flex: 1, height: 1, background: C.separator }} />
                    </div>
                  )}
                  <FlightCard f={f} view={view} />
                </Fragment>
              ))}
            </div>
          )}

          {tab === 1 && !loading && sorted.length > 0 && (
            <p style={{ textAlign: 'center', color: C.muted, fontSize: 12, marginTop: 24 }}>
              Tomorrow's flights show scheduled times only · Live data arrives on the day
            </p>
          )}
        </div>

        {/* ── Sidebar (desktop only) ── */}
        <div className="ft-sidebar" style={{ width: 320, flexShrink: 0 }}>

          {/* Live map card */}
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, overflow: 'hidden', boxShadow: '0 1px 2px rgba(22,22,22,.05)' }}>
            <div style={{ position: 'relative', height: 200, background: '#D8D3BF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, opacity: 0.5 }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={C.secondary} strokeWidth="1.5">
                  <g transform="translate(1.6 -1) scale(0.86)"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></g>
                </svg>
                <span style={{ font: `600 12px/1 'Instrument Sans', system-ui`, color: C.secondary }}>{enroute} flights in air</span>
              </div>
              {enroute > 0 && (
                <div style={{ position: 'absolute', top: 14, left: 14, display: 'flex', alignItems: 'center', gap: 7, padding: '7px 11px', borderRadius: 9, background: 'rgba(255,255,255,.94)', border: `1px solid ${C.border}` }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: C.forestMid, display: 'block' }} />
                  <span style={{ font: `600 11px/1 'Instrument Sans', system-ui`, color: C.ink }}>{enroute} flights in air</span>
                </div>
              )}
            </div>
            <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: `1px solid ${C.trackEmpty}` }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ font: `600 13.5px/1 'Instrument Sans', system-ui`, color: C.ink }}>Live map</span>
                <span style={{ font: `500 11px/1 'Instrument Sans', system-ui`, color: C.muted }}>Track flights in real-time</span>
              </div>
              <Link href="/" style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 9,
                background: C.forest, textDecoration: 'none',
              }}>
                <span style={{ font: `600 12px/1 'Instrument Sans', system-ui`, color: '#fff' }}>Open</span>
              </Link>
            </div>
          </div>

          {/* Stats card */}
          {!loading && total > 0 && (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 1px 2px rgba(22,22,22,.05)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <span style={{ font: `600 13.5px/1 'Instrument Sans', system-ui`, color: C.ink }}>Today's summary</span>
                <span style={{ font: `500 11px/1 'Instrument Sans', system-ui`, color: C.muted }}>{airport}</span>
              </div>
              {[
                { label: 'Total flights', val: total, color: C.forest },
                { label: view === 'arr' ? 'Arrived' : 'Departed', val: landed, color: C.forestMid },
                { label: 'In the air', val: enroute, color: C.golden },
                { label: 'Cancelled', val: cancelled, color: C.wine },
              ].filter(r => r.val > 0).map(row => (
                <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ font: `600 12.5px/1 'Instrument Sans', system-ui`, color: C.ink, width: 100 }}>{row.label}</span>
                  <div style={{ flex: 1, height: 6, borderRadius: 99, background: C.trackEmpty, position: 'relative' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.round((row.val / total) * 100)}%`, background: row.color, borderRadius: 99 }} />
                  </div>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600, color: C.secondary, width: 20, textAlign: 'right' }}>{row.val}</span>
                </div>
              ))}
            </div>
          )}

          {/* CTA card */}
          <div style={{ background: C.forest, borderRadius: 16, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={{ font: `700 15px/1.25 'Instrument Sans', system-ui`, color: '#EDEBE0', letterSpacing: '-.01em' }}>
              Follow a flight from anywhere
            </span>
            <span style={{ font: `400 12px/1.5 'Instrument Sans', system-ui`, color: 'rgba(237,235,224,.72)' }}>
              Get gate, delay and landing alerts for the flights your family is on — free, no account needed.
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, padding: '10px 12px', borderRadius: 9, background: '#EDEBE0', textAlign: 'center', font: `600 12px/1 'Instrument Sans', system-ui`, color: C.forest }}>
                App Store
              </div>
              <div style={{ flex: 1, padding: '10px 12px', borderRadius: 9, background: 'rgba(237,235,224,.15)', textAlign: 'center', font: `600 12px/1 'Instrument Sans', system-ui`, color: '#EDEBE0' }}>
                Google Play
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

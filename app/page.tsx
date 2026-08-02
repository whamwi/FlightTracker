'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { Suspense, useState, useEffect, useCallback } from 'react'
import { AIRLINE_LOGOS, LOGO_WHITE_BG } from '@/lib/airlines'
import { airportCity, airportFlag as apFlag, airportOffset, loadGeoData } from '@/lib/geo-data'

const Map = dynamic(() => import('@/components/Map'), { ssr: false })

const C = {
  surface:    '#FFFFFF',
  border:     '#D5DFD0',
  ink:        '#111827',
  forest:     '#054239',
  forestMid:  '#428177',
  forestLight:'#9EBFB8',
  muted:      '#6b7280',
  sunken:     '#F0EEE6',
  trackEmpty: '#E0DCCB',
}

// ── Nav icons ────────────────────────────────────────────────────────────────
const FlySyriaLogo = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 100 100" fill="none">
    <circle cx="40" cy="58" r="32" stroke="#054239" strokeWidth="2.6"/>
    <circle cx="40" cy="58" r="25" fill="#054239" stroke="#054239" strokeWidth="2.6"/>
    <g transform="rotate(90 40 58)"><path d="M40 33v50M20 38c7 8 7 32 0 40M60 38c-7 8-7 32 0 40M11 58h58" stroke="#EDEBE0" strokeWidth="2.2" strokeLinecap="round"/></g>
    <g transform="translate(58 4) rotate(-12) scale(1.7)">
      <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" fill="#B9A779" stroke="#054239" strokeWidth="1.1" strokeLinejoin="round" strokeLinecap="round"/>
    </g>
  </svg>
)
const IconFlights = ({ color }: { color: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>
  </svg>
)
const IconTrack = ({ color }: { color: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
  </svg>
)
const IconDestinations = ({ color }: { color: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="3"/>
  </svg>
)
const IconAirlines = ({ color }: { color: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19.5 2.5c-1.5-1.5-3.5-1.5-5 0L11 6 2.8 4.2l-2 2 7.4 4.5a55 55 0 0 0-3 6.3l-1.6 2 2 2 2.4-2a55 55 0 0 0 6.3-3l4.5 7.4 2-2-.8-4.2z"/>
  </svg>
)

const IconNews = ({ color }: { color: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2"/>
    <circle cx="8.5" cy="9.5" r="1.8"/>
    <path d="m3 17 5-4.5 4 3.5 3.5-3L21 17"/>
  </svg>
)

const NAV_TABS = [
  { label: 'Flights',      href: '/board',        active: false, Icon: IconFlights },
  { label: 'Track',        href: '/',             active: true,  Icon: IconTrack },
  { label: 'Destinations', href: '/destinations', active: false, Icon: IconDestinations },
  { label: 'Airlines',     href: '/airlines',     active: false, Icon: IconAirlines },
  { label: 'News',         href: '/news',         active: false, Icon: IconNews },
]

// ── InAirPanel types & helpers ───────────────────────────────────────────────
type InAirFlight = {
  iata_number: string
  airline_name: string
  airline_iata: string
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
}

const STATUS_ALIAS: Record<string, string> = { Landed: 'Arrived', Land: 'Arrived' }
const IN_AIR = new Set(['Departed', 'En Route', 'Approaching'])

function panelEffectiveStatus(f: InAirFlight): string {
  const s = STATUS_ALIAS[f.status] ?? f.status
  if (f.actual_arr_utc) return 'Arrived'
  if (s === 'Arrived' || s === 'Cancelled') return s
  if (f.actual_dep_utc) {
    const actMs = new Date(f.actual_dep_utc).getTime()
    if (f.duration_min && actMs + f.duration_min * 60_000 < Date.now() - 15 * 60_000) return 'Arrived'
    return s !== 'Unknown' && s !== 'Scheduled' ? s : 'Departed'
  }
  return s
}

function etaMs(f: InAirFlight): number {
  if (f.revised_arr_utc) return new Date(f.revised_arr_utc).getTime()
  if (f.actual_dep_utc && f.duration_min)
    return new Date(f.actual_dep_utc).getTime() + f.duration_min * 60_000
  const [h, m] = (f.arr_time_utc ?? '23:59').slice(0, 5).split(':').map(Number)
  const now = Date.now()
  const base = new Date(now)
  return Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), (h + 21) % 24, m)
}

function durationLabel(min: number) {
  return `${Math.floor(min / 60)}h ${min % 60}m`
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

// ── Airline logo (compact) ───────────────────────────────────────────────────
function MiniLogo({ iata, name }: { iata: string; name: string }) {
  const fallback = `https://images.flightsfrom.com/airlines/100/${iata}_100px.png`
  const [src, setSrc] = useState<string>(AIRLINE_LOGOS[iata] ?? fallback)
  const [failed, setFailed] = useState(!iata)

  const onError = () => {
    if (AIRLINE_LOGOS[iata] && src === AIRLINE_LOGOS[iata]) setSrc(fallback)
    else setFailed(true)
  }

  if (failed || !src) return (
    <div style={{ width: 32, height: 32, borderRadius: 8, background: '#E4E1D2', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted, fontSize: 10, fontWeight: 700, fontFamily: "'IBM Plex Mono',monospace", flexShrink: 0 }}>
      {iata.slice(0, 2).toUpperCase()}
    </div>
  )
  return (
    <div style={{ width: 32, height: 32, borderRadius: 8, overflow: 'hidden', flexShrink: 0, background: LOGO_WHITE_BG.has(iata) ? '#fff' : '#F7F5EC', border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <img src={src} alt={name} width={32} height={32} style={{ objectFit: 'contain', width: 32, height: 32 }} onError={onError} />
    </div>
  )
}

// ── Live progress bar (mini) ─────────────────────────────────────────────────
function MiniProgress({ depUtc, durationMin, approaching, accentColor }: { depUtc: string; durationMin: number; approaching: boolean; accentColor?: string }) {
  const calc = () => Math.min(100, Math.max(0, ((Date.now() - new Date(depUtc).getTime()) / (durationMin * 60_000)) * 100))
  const [pct, setPct] = useState(calc)
  useEffect(() => {
    const t = setInterval(() => setPct(calc()), 30_000)
    return () => clearInterval(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depUtc, durationMin])

  const fill  = Math.max(2, pct)
  const empty = Math.max(2, 100 - pct)
  const rem   = Math.round((1 - pct / 100) * durationMin)
  const dotColor = accentColor ?? (approaching ? C.forest : C.forestMid)

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9.5, color: C.muted, whiteSpace: 'nowrap' }}>
        {rem > 0 ? `${durationLabel(rem)} left` : 'Arriving soon'}
      </span>
      <div style={{ width: '100%', display: 'flex', alignItems: 'center', height: 16 }}>
        <div style={{ flex: fill, height: 3, borderRadius: 99, background: dotColor }} />
        <div style={{ width: 14, height: 14, borderRadius: 7, background: C.surface, border: `1.5px solid ${dotColor}`, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="8" height="8" viewBox="0 0 24 24" fill={dotColor} style={{ transform: 'rotate(90deg)' }}>
            <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
          </svg>
        </div>
        <div style={{ flex: empty, height: 3, borderRadius: 99, background: C.trackEmpty }} />
      </div>
    </div>
  )
}

// ── Compact flight card for the panel ───────────────────────────────────────
function MiniFlightCard({ f, isSelected }: { f: InAirFlight; isSelected?: boolean }) {
  const status = panelEffectiveStatus(f)
  const approaching = status === 'Approaching'
  const isAlp = f.dep_iata === 'ALP' || f.arr_iata === 'ALP'
  const railColor = isAlp ? '#f97316' : (approaching ? C.forest : C.forestMid)

  const depOff  = tzOffset(f.dep_iata)
  const arrOff  = tzOffset(f.arr_iata)
  const depTime = fmtLocal(f.actual_dep_utc ?? f.revised_dep_utc ?? f.dep_time_utc, depOff)
  const arrMs   = etaMs(f)
  const arrTime = arrMs ? fmtLocal(new Date(arrMs).toISOString(), arrOff) : fmtLocal(f.arr_time_utc, arrOff)

  const depCity  = airportCity[f.dep_iata] ?? f.dep_iata
  const arrCity  = airportCity[f.arr_iata] ?? f.arr_iata
  const depFlag  = apFlag[f.dep_iata] ?? ''
  const arrFlag  = apFlag[f.arr_iata] ?? ''

  return (
    <Link
      href={`/?flight=${encodeURIComponent(f.iata_number)}`}
      style={{ display: 'block', textDecoration: 'none', background: isSelected ? '#D4EBD4' : C.surface, border: `${isSelected ? 2 : 1}px solid ${isSelected ? C.forest : C.border}`, borderRadius: 12, overflow: 'hidden', boxShadow: isSelected ? '0 6px 20px rgba(5,66,57,0.22), 0 1px 4px rgba(5,66,57,0.12)' : '0 1px 4px rgba(0,0,0,.06)', position: 'relative', transform: isSelected ? 'translateY(-1px)' : 'none', transition: 'box-shadow .2s, transform .2s, background .2s', flexShrink: 0 }}
    >
      {/* Status rail (top) */}
      <div style={{ height: 3, background: railColor }} />

      <div style={{ padding: '10px 12px 11px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {/* Row 1: logo + flight info + badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <MiniLogo iata={f.airline_iata} name={f.airline_name} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11.5, fontWeight: 700, color: C.ink, letterSpacing: '.05em' }}>
              {f.iata_number}{f.aircraft_type ? ` · ${f.aircraft_type}` : ''}
            </div>
            <div style={{ font: `500 10.5px/1 'Instrument Sans',system-ui`, color: C.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {f.airline_name}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px 4px 6px', borderRadius: 99, background: approaching ? '#E6EFEC' : '#EBF2F1', border: `1px solid ${approaching ? '#B4CFC9' : '#BFD8D5'}`, flexShrink: 0 }}>
            <span style={{ width: 5, height: 5, borderRadius: 99, background: railColor, display: 'block' }} />
            <span style={{ font: `600 9.5px/1 'Instrument Sans',system-ui`, color: railColor, whiteSpace: 'nowrap' }}>
              {status === 'En Route' ? 'En route' : status}
            </span>
          </div>
        </div>

        {/* Row 2: route with progress */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Dep */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, width: 56, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ fontSize: 10 }}>{depFlag}</span>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, fontWeight: 700, color: C.ink }}>{f.dep_iata}</span>
            </div>
            <span style={{ font: `500 9px/1 'Instrument Sans',system-ui`, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 55 }}>{depCity}</span>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, fontWeight: 700, color: C.ink, marginTop: 2 }}>{depTime}</span>
          </div>

          {/* Progress */}
          {f.actual_dep_utc && f.duration_min > 0 ? (
            <MiniProgress depUtc={f.actual_dep_utc} durationMin={f.duration_min} approaching={approaching} accentColor={isAlp ? '#f97316' : undefined} />
          ) : (
            <div style={{ flex: 1, height: 3, borderRadius: 99, background: C.trackEmpty }} />
          )}

          {/* Arr */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, width: 56, flexShrink: 0, alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, fontWeight: 700, color: C.ink }}>{f.arr_iata}</span>
              <span style={{ fontSize: 10 }}>{arrFlag}</span>
            </div>
            <span style={{ font: `500 9px/1 'Instrument Sans',system-ui`, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 55, textAlign: 'right' }}>{arrCity}</span>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, fontWeight: 700, color: approaching ? C.forest : C.ink, marginTop: 2 }}>{arrTime}</span>
          </div>
        </div>
      </div>
    </Link>
  )
}

// ── In-air side panel ────────────────────────────────────────────────────────
function InAirPanel({ selectedFlight, open, setOpen }: { selectedFlight?: string; open: boolean; setOpen: (v: boolean) => void }) {
  const router = useRouter()
  const [flights, setFlights] = useState<InAirFlight[]>([])
  const [loading, setLoading] = useState(true)
  const [geoReady, setGeoReady] = useState(false)

  const load = useCallback(async () => {
    const d = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
    try {
      const res = await fetch(`/api/flightboard?date=${d}`)
      if (!res.ok) return
      const json = await res.json()
      const inAir = ((json.flights ?? []) as InAirFlight[])
        .filter(f => IN_AIR.has(panelEffectiveStatus(f)))
        .sort((a, b) => etaMs(a) - etaMs(b))
      setFlights(inAir)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGeoData().then(() => setGeoReady(true))
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load])

  const count = flights.length

  // ── Closed: pill FAB ─────────────────────────────────────────────────────
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fab-pill"
        style={{
          position: 'absolute', left: 12, top: 12, zIndex: 1000,
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '9px 13px', borderRadius: 99,
          background: count > 0 ? C.forest : 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
          border: count > 0 ? `1px solid rgba(255,255,255,.15)` : `1px solid ${C.border}`,
          boxShadow: '0 2px 10px rgba(0,0,0,.18)',
          cursor: 'pointer',
        }}
      >
        <span className="live-dot" style={{ width: 7, height: 7, borderRadius: 99, background: count > 0 ? '#7effd4' : C.muted, display: 'block', flexShrink: 0 }} />
        <span style={{ font: `600 12.5px/1 'Instrument Sans',system-ui`, color: count > 0 ? '#fff' : C.ink, whiteSpace: 'nowrap' }}>
          {loading ? 'Loading…' : count === 0 ? 'No flights in air' : `${count} in air`}
        </span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={count > 0 ? '#fff' : C.muted} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19.5 2.5c-1.5-1.5-3.5-1.5-5 0L11 6 2.8 4.2l-2 2 7.4 4.5a55 55 0 0 0-3 6.3l-1.6 2 2 2 2.4-2a55 55 0 0 0 6.3-3l4.5 7.4 2-2-.8-4.2z"/>
        </svg>
      </button>
    )
  }

  // ── Open: side panel ─────────────────────────────────────────────────────
  return (
    <div style={{
      position: 'absolute', left: 12, top: 12, zIndex: 999,
      width: 'min(308px, calc(88vw - 12px))',
      maxHeight: 'calc(100% - 24px)',
      display: 'flex', flexDirection: 'column',
      background: 'rgba(237,235,224,0.97)',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      border: `1px solid ${C.border}`,
      borderRadius: 16,
      boxShadow: '0 4px 28px rgba(0,0,0,.13)',
      overflow: 'hidden',
    }}>
      {/* Panel header */}
      <div style={{ padding: '14px 14px 11px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'flex-start', gap: 10, flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span className="live-dot" style={{ width: 7, height: 7, borderRadius: 99, background: count > 0 ? C.forestMid : C.muted, display: 'block', flexShrink: 0 }} />
            <span style={{ font: `700 13.5px/1 'Instrument Sans',system-ui`, color: C.ink }}>Flights in air</span>
          </div>
          <span style={{ font: `500 10.5px/1 'Instrument Sans',system-ui`, color: C.muted, marginTop: 5, display: 'block' }}>
            {loading ? 'Loading…' : `${count} ${count === 1 ? 'flight' : 'flights'} · sorted by arrival`}
          </span>
        </div>
        {/* Selection lives in the URL (/?flight=XX123), set by tapping a card. Without a way
            back to `/` the only escape was editing the address bar or reloading.
            router.replace, not <Link href="/">: the App Router keys its client cache on the
            pathname, so a Link from /?flight=X to / is treated as the same route and the query
            survives. That works in dev (caching disabled) and silently fails in production —
            verified on the deployed site before switching. replace() rather than push() so
            clearing does not add a history entry to back through. */}
        {selectedFlight && (
          <button
            onClick={() => router.replace('/', { scroll: false })}
            aria-label="Clear selected flight"
            style={{
              height: 28, borderRadius: 8, border: `1px solid ${C.border}`, background: C.sunken,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, color: C.muted, padding: '0 9px',
              font: `600 11px/1 'Instrument Sans',system-ui`, whiteSpace: 'nowrap',
            }}
          >
            Clear
          </button>
        )}
        <button
          onClick={() => setOpen(false)}
          aria-label="Close panel"
          style={{ width: 28, height: 28, borderRadius: 8, border: `1px solid ${C.border}`, background: C.sunken, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: C.muted, fontSize: 13, lineHeight: 1 }}
        >
          ✕
        </button>
      </div>

      {/* Card list */}
      <div style={{ overflowY: 'auto', overscrollBehavior: 'contain', padding: '10px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 0', gap: 10 }}>
            <div style={{ width: 24, height: 24, border: `2px solid ${C.forestMid}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin .8s linear infinite' }} />
            <span style={{ font: `500 11px/1 'Instrument Sans',system-ui`, color: C.muted }}>Loading…</span>
          </div>
        )}
        {!loading && count === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 0', gap: 10, textAlign: 'center' }}>
            <span style={{ fontSize: 36 }}>✈</span>
            <span style={{ font: `600 12.5px/1.4 'Instrument Sans',system-ui`, color: C.muted }}>No flights<br/>currently in air</span>
          </div>
        )}
        {!loading && flights.map(f => (
          <MiniFlightCard key={`${f.iata_number}-${f.dep_iata}-${f.arr_iata}`} f={f} isSelected={f.iata_number === selectedFlight} />
        ))}
      </div>
    </div>
  )
}

// ── Main map page ────────────────────────────────────────────────────────────
function HomeInner() {
  const searchParams = useSearchParams()
  const flight = searchParams.get('flight') ?? undefined
  const [panelOpen, setPanelOpen] = useState(true)

  useEffect(() => {
    if (window.innerWidth < 640) setPanelOpen(false)
  }, [])

  useEffect(() => {
    if (flight) setPanelOpen(false)
  }, [flight])

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.35 } }
        @keyframes fab-attract {
          0%, 75%, 100% { transform: scale(1);    box-shadow: 0 2px 10px rgba(0,0,0,.18), 0 0 0 0px rgba(20,120,80,0); }
          82%           { transform: scale(1.08); box-shadow: 0 4px 20px rgba(20,120,80,.5), 0 0 0 6px rgba(20,120,80,.35); }
          90%           { transform: scale(1.03); box-shadow: 0 2px 14px rgba(20,120,80,.2), 0 0 0 11px rgba(20,120,80,.1); }
          97%           { transform: scale(1);    box-shadow: 0 2px 10px rgba(0,0,0,.18), 0 0 0 15px rgba(20,120,80,0); }
        }
        .live-dot { animation: pulse 2s infinite; }
        .fab-pill { animation: fab-attract 6s 1s infinite; transition: transform .15s ease, box-shadow .15s ease; }
        .fab-pill:hover { transform: translateY(-2px) scale(1.04) !important; box-shadow: 0 6px 22px rgba(0,0,0,.28) !important; animation-play-state: paused; }
        .map-top-nav {
          display: flex; align-items: center;
          padding: env(safe-area-inset-top) 16px 0;
          height: calc(56px + env(safe-area-inset-top));
          background: ${C.surface};
          border-bottom: 1px solid ${C.border};
          flex-shrink: 0;
        }
        .map-bottom-nav {
          display: flex; align-items: stretch;
          background: rgba(255,255,255,0.94);
          backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
          border-top: 1px solid ${C.border};
          padding-bottom: env(safe-area-inset-bottom);
          height: calc(60px + env(safe-area-inset-bottom));
          flex-shrink: 0;
        }
        .map-btab {
          flex: 1; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 3px;
          text-decoration: none; padding: 8px 4px 6px;
          -webkit-tap-highlight-color: transparent; position: relative;
        }
        .map-btab-label { font-family:'Instrument Sans',system-ui; font-size:10px; font-weight:600; letter-spacing:.01em; }
        .map-btab-active-dot {
          position: absolute; bottom: 6px; left: 50%; transform: translateX(-50%);
          width: 4px; height: 4px; border-radius: 50%; background: ${C.forest};
        }
        .map-legend { bottom: calc(72px + env(safe-area-inset-bottom)); right: 12px; }
        .map-desktop-tabs-inline { display: none; }
        @media (min-width: 768px) {
          .map-top-nav { display: flex; }
          .map-bottom-nav { display: none; }
          .map-desktop-tabs-inline { display: flex; }
          .map-legend { bottom: 24px; right: 12px; }
        }
      `}</style>

      {/* Top nav */}
      <nav className="map-top-nav">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FlySyriaLogo />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ font: `700 16px/1 'Instrument Sans', system-ui`, color: C.ink, letterSpacing: '-.01em', whiteSpace: 'nowrap' }}>FlySyria</span>
          </div>
        </div>
        <div style={{ marginLeft: 24, gap: 2 }} className="map-desktop-tabs-inline">
          {NAV_TABS.map(t => (
            <Link key={t.label} href={t.href} style={{
              display: 'flex', alignItems: 'center', padding: '7px 14px',
              whiteSpace: 'nowrap', textDecoration: 'none', borderRadius: 8,
              font: `${t.active ? 700 : 600} 13.5px/1 'Instrument Sans', system-ui`,
              color: t.active ? C.forest : C.muted,
              background: t.active ? C.sunken : 'transparent',
            }}>
              {t.label}
            </Link>
          ))}
        </div>
      </nav>

      {/* Map area */}
      <main style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <Map targetFlight={flight} panelOpen={panelOpen} />

        {/* In-air side panel */}
        <InAirPanel selectedFlight={flight} open={panelOpen} setOpen={setPanelOpen} />

        {/* Legend (bottom-right, above bottom nav on mobile) */}
        <div className="map-legend" style={{ position: 'absolute', zIndex: 1000, background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(6px)', borderRadius: 10, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 5, boxShadow: '0 1px 4px rgba(0,0,0,0.12)' }}>
          {[
            { color: '#16a34a', label: 'Damascus (DAM)' },
            { color: '#f97316', label: 'Aleppo (ALP)'   },
          ].map(({ color, label }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill={color}>
                <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
              </svg>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#374151', fontFamily: "'Instrument Sans', system-ui", whiteSpace: 'nowrap' }}>{label}</span>
            </div>
          ))}
        </div>
      </main>

      {/* Mobile bottom tab bar */}
      <nav className="map-bottom-nav">
        {NAV_TABS.map(t => {
          const color = t.active ? C.forest : C.muted
          return (
            <Link key={t.href} href={t.href} className="map-btab">
              <t.Icon color={color} />
              <span className="map-btab-label" style={{ color }}>{t.label}</span>
              {t.active && <span className="map-btab-active-dot" />}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}

export default function Home() {
  return (
    <Suspense>
      <HomeInner />
    </Suspense>
  )
}

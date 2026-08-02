'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState, useEffect, useCallback } from 'react'
import { AIRLINE_LOGOS, LOGO_WHITE_BG } from '@/lib/airlines'
import { airportCity, airportFlag as apFlag, airportOffset, loadGeoData } from '@/lib/geo-data'
import Wordmark from '@/components/Wordmark'
import SiteNav from '@/components/SiteNav'

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
function MiniFlightCard({ f, isSelected, onSelect }: { f: InAirFlight; isSelected?: boolean; onSelect: (n: string) => void }) {
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
      onClick={(e) => { e.preventDefault(); onSelect(f.iata_number) }}
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
function InAirPanel({ selectedFlight, open, setOpen, onSelect, onClear }: { selectedFlight?: string; open: boolean; setOpen: (v: boolean) => void; onSelect: (n: string) => void; onClear: () => void }) {
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
      <div style={{ position: 'absolute', left: 12, top: 12, zIndex: 1000, display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        onClick={() => setOpen(true)}
        className="fab-pill"
        style={{
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
      {/* Selecting a flight collapses the panel on phones, which is where you are looking
          right after you select one — so the header's Clear button is exactly the thing you
          cannot reach. Repeat it here, naming the flight so it is obvious what is selected. */}
      {selectedFlight && (
        <button
          onClick={onClear}
          aria-label={`Clear ${selectedFlight}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '9px 12px', borderRadius: 99,
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
            border: `1px solid ${C.border}`, boxShadow: '0 2px 10px rgba(0,0,0,.18)',
            cursor: 'pointer', color: C.ink, whiteSpace: 'nowrap',
          }}
        >
          <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11.5, fontWeight: 700, letterSpacing: '.05em' }}>{selectedFlight}</span>
          <span style={{ color: C.muted, fontSize: 12, lineHeight: 1 }}>✕</span>
        </button>
      )}
      </div>
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
        {/* Clearing a selection. The obvious spellings — <Link href="/"> and router.replace('/')
            — both leave ?flight= in the address bar in a production build: the App Router keys
            its client cache on the pathname and treats a query-only change back to the bare
            route as the same navigation. Neither fails in dev, where that caching is off, so
            this was only caught by testing the deployed site. Selection therefore lives in
            React state (see HomeInner) with the URL kept in sync by history.replaceState, and
            the router is out of the loop entirely. Rendered only when something is selected. */}
        {selectedFlight && (
          <button
            onClick={onClear}
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
          <MiniFlightCard key={`${f.iata_number}-${f.dep_iata}-${f.arr_iata}`} f={f} isSelected={f.iata_number === selectedFlight} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}

// ── Main map page ────────────────────────────────────────────────────────────
function HomeInner() {
  const searchParams = useSearchParams()
  const urlFlight = searchParams.get('flight') ?? undefined
  // Seeded from the URL so deep links keep working, but state is the source of truth from then
  // on — see the note on the Clear button for why the router cannot own this.
  const [flight, setFlight] = useState<string | undefined>(urlFlight)
  useEffect(() => { setFlight(urlFlight) }, [urlFlight])

  const syncUrl = useCallback((n?: string) => {
    const q = n ? `?flight=${encodeURIComponent(n)}` : ''
    window.history.replaceState(null, '', `${window.location.pathname}${q}`)
  }, [])
  const selectFlight = useCallback((n: string) => { setFlight(n); syncUrl(n) }, [syncUrl])
  const clearFlight  = useCallback(() => { setFlight(undefined); syncUrl(undefined) }, [syncUrl])

  const [panelOpen, setPanelOpen] = useState(true)

  useEffect(() => {
    if (window.innerWidth < 640) setPanelOpen(false)
  }, [])

  // Collapse on select only where the panel actually covers the map. On a wide screen there
  // is room for both, and keeping it open leaves the Clear button in reach.
  useEffect(() => {
    if (flight && window.innerWidth < 640) setPanelOpen(false)
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
        .map-legend { bottom: calc(16px + env(safe-area-inset-bottom)); right: 12px; }
        @media (min-width: 768px) {
          .map-legend { bottom: 24px; right: 12px; }
        }
      `}</style>

      <SiteNav active="Track" />

      {/* Map area */}
      <main style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <Map targetFlight={flight} panelOpen={panelOpen} />

        {/* In-air side panel */}
        <InAirPanel selectedFlight={flight} open={panelOpen} setOpen={setPanelOpen} onSelect={selectFlight} onClear={clearFlight} />

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

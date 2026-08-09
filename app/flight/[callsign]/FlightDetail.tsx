'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { AIRLINE_LOGOS, LOGO_WHITE_BG } from '@/lib/airlines'
import { airportCity, cityFor, airlineNameFor, airportLabelFor, airportFlag as apFlag, airportOffset, loadGeoData } from '@/lib/geo-data'
import { isSyrianAirport } from '@/lib/syria-airports'
import { useT, useHref, useLocale } from '@/components/LocaleProvider'
import { STATUS_KEY, type Locale } from '@/lib/i18n'

const cityOf = (iata: string) => cityFor(iata)
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

/**
 * The numeric part of a flight number, whichever prefix form it carries.
 *
 * `replace(/^[A-Z0-9]{2,3}/, '')` was greedy and took three characters wherever it could, so
 * only the three-letter ICAO forms survived:
 *
 *   FYC744 → 744   correct
 *   XH744  → 44    wrong
 *   TK846  → 46    wrong
 *   G9375  → 75    wrong
 *
 * Every link the board generates uses the IATA form, so the ICAO fallback below was asking for
 * FYC44 and THY46 — a different flight, or none. It went unnoticed because the registration
 * lookup ahead of it usually succeeds; it only bites on flights with no ADS-B, which over
 * Syria is most of them.
 *
 * Three letters then digits is ICAO (FYC744, THY846). Otherwise two characters — and those two
 * cannot be assumed to start with a letter: IATA codes come as TK, as G9, and as 3L, which is
 * Air Arabia Abu Dhabi and reads 3L504.
 */
function flightDigits(num: string): string {
  const up = num.replace(/\s+/g, '').toUpperCase()
  return up.match(/^[A-Z]{3}(\d+)$/)?.[1]
      ?? up.match(/^[A-Z0-9]{2}(\d+)$/)?.[1]
      ?? up.replace(/^[A-Z0-9]{2,3}/, '')
}

function fmtNum(raw: string) {
  const m = raw.match(/^([A-Z]{2,3})(\d+.*)$/)
  return m ? `${m[1]} ${m[2]}` : raw
}

/*
 * Arabic carries no English unit letters: an hour or more reads as 3:15, less than an hour
 * as 45 د. The colon form only works once there is an hour to anchor it — 0:45 reads like a
 * clock time rather than a length.
 */
function durationLabel(min: number, locale: Locale) {
  const h = Math.floor(min / 60), m = min % 60
  if (locale === 'ar') return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m} د`
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
  const locale = useLocale()
  if (Math.abs(min) < 2) return null
  // marginInlineStart, not marginLeft: the badge follows the time, which is the left side in
  // Arabic — the physical value pushed it away from the number it belongs to.
  const unit = locale === 'ar' ? 'د' : 'm'
  /*
   * Laid out by hand, because bidi will not do it.
   *
   * The badge should read د6+ on screen: unit, number, sign. Under dir=rtl the algorithm puts
   * the Arabic letter rightmost and throws the sign to the far left whatever order the string
   * is in — both "+6د" and "د6+" came out as "+6د". So the span is forced to ltr, which makes
   * rendering literal, and the characters are written in the order they should appear.
   */
  return (
    <span dir="ltr" style={{ background: C.goldenBg, color: C.goldenTx, fontSize: 10, fontWeight: 700, padding: '2px 5px', borderRadius: 99, marginInlineStart: 5, lineHeight: 1.4 }}>
      {locale === 'ar'
        ? `${unit}${Math.abs(min)}${min > 0 ? '+' : '-'}`
        : (min > 0 ? `+${min}${unit}` : `${min}${unit}`)}
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

function PlanePin() {
  /*
   * The nose points at the destination, and which way that is depends on the script.
   *
   * The path is drawn nose-up; rotate(90) turns it right, which is correct in English and
   * exactly backwards in Arabic, where the journey runs right to left. A fixed rotation left
   * the aircraft flying at the airport it had just come from.
   */
  const locale = useLocale()
  return (
    <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', border: '1px solid #D8D3BF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <svg width={10} height={10} viewBox="0 0 24 24" fill="none" style={{ display: 'block', pointerEvents: 'none' }}>
        <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"
          fill="#054239" transform={`rotate(${locale === 'ar' ? -90 : 90} 12 12)`} />
      </svg>
    </div>
  )
}

export default function FlightDetail({ callsign }: { callsign: string }) {
  const t      = useT()
  const href   = useHref()
  const locale = useLocale()
  // Only present on links made from a day other than today — see fetchFlight.
  const onDate = useSearchParams().get('date')
  const [flight, setFlight]   = useState<Flight | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [photo, setPhoto]     = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState(0)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => { loadGeoData() }, [])

  /*
   * The day the link was made on, when it was not today.
   *
   * /api/flight searches today before yesterday and returns the first hit, so the same number
   * on two consecutive days always resolved to the later one — sharing a flight off the
   * Yesterday tab opened today's service instead.
   */
  const fetchFlight = useCallback(async () => {
    try {
      const q = onDate ? `&date=${encodeURIComponent(onDate)}` : ''
      const res = await fetch(`/api/flight?num=${encodeURIComponent(callsign)}${q}`)
      if (res.status === 404) { setNotFound(true); setLoading(false); return }
      if (!res.ok) return
      const data = await res.json()
      if (data.ok) { setFlight(data.flight); setNotFound(false) }
    } catch {}
    setLoading(false)
    setLastRefresh(Date.now())
  }, [callsign, onDate])

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
      const digits = flightDigits(callsign)

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

  // Estimated arrival: actual_dep + duration when no explicit revised/actual arr is available
  const estimatedArrUtc = flight && !flight.actual_arr_utc && !flight.revised_arr_utc && flight.actual_dep_utc && flight.duration_min > 0
    ? new Date(new Date(flight.actual_dep_utc).getTime() + flight.duration_min * 60_000).toISOString()
    : null

  const depDisplay = flight
    ? (flight.actual_dep_utc ? isoToLocal(flight.actual_dep_utc, depOffset)
      : flight.revised_dep_utc ? isoToLocal(flight.revised_dep_utc, depOffset)
      : utcHHMMtoLocal(flight.dep_time_utc, depOffset))
    : '—'
  const arrDisplay = flight
    ? (flight.actual_arr_utc ? isoToLocal(flight.actual_arr_utc, arrOffset)
      : flight.revised_arr_utc ? isoToLocal(flight.revised_arr_utc, arrOffset)
      : estimatedArrUtc ? isoToLocal(estimatedArrUtc, arrOffset)
      : utcHHMMtoLocal(flight.arr_time_utc, arrOffset))
    : '—'

  const depDelay = flight?.actual_dep_utc ? calcDelayMin(flight.dep_time_utc, flight.actual_dep_utc, flight.date)
    : flight?.revised_dep_utc ? calcDelayMin(flight.dep_time_utc, flight.revised_dep_utc, flight.date) : 0
  const arrDelay = flight?.actual_arr_utc ? calcDelayMin(flight.arr_time_utc, flight.actual_arr_utc, flight.date)
    : flight?.revised_arr_utc ? calcDelayMin(flight.arr_time_utc, flight.revised_arr_utc, flight.date)
    : estimatedArrUtc ? calcDelayMin(flight!.arr_time_utc, estimatedArrUtc, flight!.date) : 0

  /*
   * What the big number actually is, and what it replaced.
   *
   * The card shows one time and a variance badge, which answers "when" but not "instead of
   * what" — a reader told 06:20 by the passenger sees 06:01 −19m and has to do the arithmetic
   * to be sure it is the same flight. Airportia shows the original struck through beside it,
   * which is the convention on an airport departure board too.
   *
   * The kind matters as much as the number: an actual time is observed, an estimated one is a
   * prediction, and they currently look identical.
   */
  const depKind = flight?.actual_dep_utc ? 'label.actual'
                : flight?.revised_dep_utc ? 'label.estimated' : 'label.scheduled'
  const arrKind = flight?.actual_arr_utc ? 'label.actual'
                : (flight?.revised_arr_utc || estimatedArrUtc) ? 'label.estimated' : 'label.scheduled'

  // The scheduled time, shown struck through only when the displayed one differs from it.
  const depSched = flight ? utcHHMMtoLocal(flight.dep_time_utc, depOffset) : '—'
  const arrSched = flight ? utcHHMMtoLocal(flight.arr_time_utc, arrOffset) : '—'
  const depMoved = depSched !== depDisplay
  const arrMoved = arrSched !== arrDisplay

  // En-route progress (uses live `now` so it ticks every 30s)
  const depMs = isEnRoute && flight?.actual_dep_utc ? new Date(flight.actual_dep_utc).getTime() : null
  const progressPct = (() => {
    if (!isEnRoute || depMs == null || !flight?.duration_min) return null
    const p = ((now - depMs) / (flight.duration_min * 60_000)) * 100
    return Math.min(95, Math.max(3, p))
  })()

  const elapsedMin = depMs != null ? Math.max(0, Math.floor((now - depMs) / 60_000)) : null
  const remainingMin = elapsedMin != null && flight?.duration_min
    ? Math.max(0, flight.duration_min - elapsedMin) : null

  // Which board this flight belongs to — its Syrian end. Checked against the shared list, so
  // a Deir ez-Zor or Latakia arrival resolves to that airport instead of falling through to
  // the foreign origin.
  const boardAirport = flight
    ? (isSyrianAirport(flight.arr_iata) ? flight.arr_iata : flight.dep_iata) || 'DAM'
    : 'DAM'

  function handleShare() {
    if (!flight) return
    /*
     * The shared text is the thing that travels — into WhatsApp, where most of this product
     * spreads. It has to be in the reader's language, and the cities read better than the
     * codes when it lands somewhere with no other context.
     */
    const status = STATUS_KEY[flight.status] ? t(STATUS_KEY[flight.status]) : (statusCfg?.label ?? '')
    const text = `${fmtNum(flight.iata_number)} · ${cityOf(flight.dep_iata)} → ${cityOf(flight.arr_iata)} · ${status}`
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
        <Link href={href('/board')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.border}`, background: C.card, color: C.ink, textDecoration: 'none', flexShrink: 0 }}>
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
          <div style={{ fontSize: 18, fontWeight: 700, color: C.ink, marginBottom: 8 }}>{t('error.flight_not_found')}</div>
          <div style={{ fontSize: 13, color: C.muted }}>{t('error.no_data_for')} {fmtNum(callsign)} {t('error.today_or_yesterday')}</div>
          {/* The arrow mirrors with the script — see --dir-flip. */}
          <Link href={href('/board')} style={{ display: 'inline-block', marginTop: 20, fontSize: 13, fontWeight: 600, color: C.forest, textDecoration: 'none' }}>
            <span style={{ display: 'inline-block', transform: 'scaleX(var(--dir-flip, 1))' }}>←</span> {t('action.all_flights')}
          </Link>
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
            <AirlineLogo iata={flight.airline_iata} name={airlineNameFor(flight.airline_iata, flight.airline_name)} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, lineHeight: 1.25 }}>{airlineNameFor(flight.airline_iata, flight.airline_name)}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                {fmtNum(flight.iata_number)}{flight.aircraft_type ? ` · ${flight.aircraft_type}` : ''}
              </div>
            </div>
            <span style={{ background: statusCfg.bg, color: statusCfg.text, fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 99, flexShrink: 0, marginTop: 1 }}>
              {flight && STATUS_KEY[flight.status] ? t(STATUS_KEY[flight.status]) : statusCfg.label}
            </span>
          </div>

          {/* 3. Route progress */}
          <div style={{ padding: '2px 14px 14px' }}>

            {/*
              Time remaining above the bar, time flown below it, both centred.
              Two facts about the same journey read better on either side of the thing that
              represents it than crowded onto one line with a separator.
            */}
            {isEnRoute && remainingMin != null && (
              <div style={{ textAlign: 'center', marginBottom: 2 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.forest }}>{durationLabel(remainingMin, locale)} {t('label.left')}</span>
              </div>
            )}
            {isArrived && flight.duration_min > 0 && (
              <div style={{ textAlign: 'center', color: C.muted, fontSize: 11, marginBottom: 2 }}>{t('label.flight_time')} {durationLabel(flight.duration_min, locale)}</div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {/* DEP */}
              <div style={{ flexShrink: 0 }}>
                <div style={{ fontSize: 12, color: C.mid, whiteSpace: 'nowrap' }}>{flagOf(flight.dep_iata)} {cityOf(flight.dep_iata)}</div>
                <div style={{ fontSize: 10, color: C.muted, fontFamily: 'monospace' }}>{flight.dep_iata}</div>
              </div>

              {/* Bar + plane */}
              <div style={{ flex: 1, position: 'relative', height: 3, background: C.track, borderRadius: 3 }}>
                {/* Blue fill */}
                <div style={{
                  position: 'absolute', insetInlineStart: 0, top: 0, bottom: 0, borderRadius: 3,
                  background: BLUE,
                  width: isArrived ? '100%' : isEnRoute && progressPct != null ? `${progressPct}%` : '0%',
                }} />
                {/*
                  The plane rides the leading edge of the fill, so its position is measured
                  from the origin — which is the right-hand end in Arabic. `left` is physical:
                  at 35% flown it put the aircraft 35% in from the left while the fill ran 35%
                  in from the right, leaving the plane behind the untravelled section rather
                  than at the front of the travelled one.
                */}
                {!isEnRoute && !isArrived && (
                  <div style={{ position: 'absolute', top: '50%', insetInlineStart: -9, transform: 'translateY(-50%)', zIndex: 2 }}>
                    <PlanePin />
                  </div>
                )}
                {/* En route: plane at progress position */}
                {isEnRoute && progressPct != null && (
                  <div style={{ position: 'absolute', top: '50%', left: `${locale === 'ar' ? 100 - progressPct : progressPct}%`, transform: 'translate(-50%, -50%)', zIndex: 2 }}>
                    <PlanePin />
                  </div>
                )}
                {/* Arrived: plane centered on the destination end of the bar */}
                {isArrived && (
                  <div style={{ position: 'absolute', top: '50%', insetInlineEnd: -9, transform: 'translateY(-50%)', zIndex: 2 }}>
                    <PlanePin />
                  </div>
                )}
              </div>

              {/* ARR — textAlign 'end', not 'right': the physical value pins the label to the
                  left edge under RTL, which is the departure side. */}
              <div style={{ flexShrink: 0, textAlign: 'end' }}>
                <div style={{ fontSize: 12, color: C.mid, whiteSpace: 'nowrap' }}>{cityOf(flight.arr_iata)} {flagOf(flight.arr_iata)}</div>
                <div style={{ fontSize: 10, color: C.muted, fontFamily: 'monospace' }}>{flight.arr_iata}</div>
              </div>
            </div>

            {isEnRoute && elapsedMin != null && (
              <div style={{ textAlign: 'center', marginTop: 2 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: C.muted }}>{durationLabel(elapsedMin, locale)} {t('label.elapsed')}</span>
              </div>
            )}
          </div>

          {/* 4. Times — bordered frame */}
          <div style={{ margin: '0 13px 12px', borderRadius: 10, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
          <div style={{ display: 'flex', background: C.times, padding: '11px 14px' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 9, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: locale === 'ar' ? 'normal' : '0.6px', marginBottom: 3, display: 'flex', gap: 4, alignItems: 'baseline' }}>
                <span>{t('label.departure')}</span>
                {/* The kind belongs with the big number it describes. Beside the struck one it
                    read as though the scheduled time were the actual. */}
                {!isCancelled && depMoved && <span style={{ fontSize: 8, fontWeight: 500, opacity: .75, textTransform: 'none' }}>({t(depKind)})</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline' }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: isCancelled ? C.muted : C.ink, fontVariantNumeric: 'tabular-nums', textDecoration: isCancelled ? 'line-through' : 'none' }}>
                  {depDisplay}
                </span>
                {!isCancelled && <DelayBadge min={depDelay} />}
              </div>
              {/* Only when it moved — repeating an unchanged time says nothing and costs a line. */}
              {!isCancelled && depMoved && (
                <div style={{ fontSize: 10, color: C.muted, marginTop: 2, display: 'flex', gap: 5, alignItems: 'baseline' }}>
                  <span>{t('label.scheduled')}</span>
                  <span style={{ textDecoration: 'line-through', fontVariantNumeric: 'tabular-nums' }}>{depSched}</span>
                </div>
              )}
            </div>
            <div style={{ flex: 1, textAlign: 'end' }}>
              <div style={{ fontSize: 9, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: locale === 'ar' ? 'normal' : '0.6px', marginBottom: 3, display: 'flex', gap: 4, alignItems: 'baseline', justifyContent: 'flex-end' }}>
                {/* Label then kind, matching the departure side — the block is right-aligned,
                    which is not a reason to reverse the words inside it. */}
                <span>{t('label.arrival')}</span>
                {!isCancelled && arrMoved && <span style={{ fontSize: 8, fontWeight: 500, opacity: .75, textTransform: 'none' }}>({t(arrKind)})</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end' }}>
                {!isCancelled && <DelayBadge min={arrDelay} />}
                <span style={{ fontSize: 20, fontWeight: 700, color: isCancelled ? C.muted : C.ink, fontVariantNumeric: 'tabular-nums', textDecoration: isCancelled ? 'line-through' : 'none' }}>
                  {arrDisplay}
                </span>
              </div>
              {!isCancelled && arrMoved && (
                <div style={{ fontSize: 10, color: C.muted, marginTop: 2, display: 'flex', gap: 5, alignItems: 'baseline', justifyContent: 'flex-end' }}>
                  <span style={{ textDecoration: 'line-through', fontVariantNumeric: 'tabular-nums' }}>{arrSched}</span>
                  <span>{t('label.scheduled')}</span>
                </div>
              )}
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
              {t('action.share')}
            </button>
            {/* Track → live map */}
            <Link href={href(`/map?flight=${encodeURIComponent(flight.iata_number)}`)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: '#EBF3EF', color: C.forest, border: `1px solid #B8D8CC`, borderRadius: 10, padding: '10px 8px', fontSize: 12, fontWeight: 600, textDecoration: 'none' }}>
              <svg width={12} height={12} viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="6.5" r="3" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M8 15C8 15 2.5 10 2.5 6.5a5.5 5.5 0 0 1 11 0C13.5 10 8 15 8 15z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
              </svg>
              {t('nav.track_button')}
            </Link>
            {/* Airport board */}
            <Link href={href('/board')} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: '#F7F5EC', color: C.ink, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 8px', fontSize: 12, fontWeight: 600, textDecoration: 'none' }}>
              <span style={{ whiteSpace: 'nowrap' }}>{airportLabelFor(boardAirport)}</span>
              {/* Mirrored, not rotated: an arrow means "this way to the board", and that way
                  is leftward in Arabic. */}
              <svg width={11} height={11} viewBox="0 0 14 14" fill="none" style={{ transform: 'scaleX(var(--dir-flip, 1))' }}>
                <path d="M4 7h7M8 4l3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </Link>
          </div>

          {lastRefresh > 0 && (
            <div style={{ textAlign: 'center', paddingBottom: 10, fontSize: 9, color: C.muted, fontFamily: 'monospace' }}>
              {t('label.updated')} {new Date(lastRefresh).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

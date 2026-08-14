'use client'
import { PHONE_MQ } from '@/lib/breakpoints'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState, useEffect, useCallback, useRef } from 'react'
import { AIRLINE_LOGOS, LOGO_WHITE_BG } from '@/lib/airlines'
import { cityFor, airlineNameFor, getActiveLocale, airportFlag as apFlag, airportOffset, loadGeoData } from '@/lib/geo-data'
import { useT, useLocale, useHref } from '@/components/LocaleProvider'
import { effectiveStatus, calcDelay } from '@/lib/flight-status'
import { DelayChip } from '@/components/FlightMeta'
import { STATUS_KEY, counted } from '@/lib/i18n'
import Wordmark from '@/components/Wordmark'
import SiteNav from '@/components/SiteNav'
import { markerHub, MARKER_ACCENT } from '@/lib/syria-airports'

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
  callsign?: string | null
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
  // The board sends terminal, gate and belt too. Deliberately not declared here: they were shown
  // on this card briefly and removed — a third row on every card, where this is a summary. The
  // popup carries them for anyone who wants that detail.
  arr_next_day?: boolean
}

const IN_AIR = new Set(['Departed', 'En Route', 'Approaching'])

function etaMs(f: InAirFlight): number {
  if (f.revised_arr_utc) return new Date(f.revised_arr_utc).getTime()
  if (f.actual_dep_utc && f.duration_min)
    return new Date(f.actual_dep_utc).getTime() + f.duration_min * 60_000
  const [h, m] = (f.arr_time_utc ?? '23:59').slice(0, 5).split(':').map(Number)
  const now = Date.now()
  const base = new Date(now)
  return Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), (h + 21) % 24, m)
}

// Arabic carries no English unit letters — see the twin in FlightDetail.
function durationLabel(min: number) {
  const h = Math.floor(min / 60), m = min % 60
  if (getActiveLocale() === 'ar') return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : counted('ar', m, 'noun.minute')
  // No leading "0h": under an hour this read "0h 47m left", which the other cards never did.
  return h > 0 ? `${h}h ${m}m` : `${m}m`
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
  const t      = useT()
  const locale = useLocale()
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
        {rem > 0 ? `${durationLabel(rem)} ${t('map.until_arrival')}` : t('map.arriving_soon')}
      </span>
      <div style={{ width: '100%', display: 'flex', alignItems: 'center', height: 16 }}>
        <div style={{ flex: fill, height: 3, borderRadius: 99, background: dotColor }} />
        <div style={{ width: 14, height: 14, borderRadius: 7, background: C.surface, border: `1.5px solid ${dotColor}`, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {/* Nose at the destination, which is the left-hand end when the row runs right to left. */}
          <svg width="8" height="8" viewBox="0 0 24 24" fill={dotColor} style={{ transform: `rotate(${locale === 'ar' ? -90 : 90}deg)` }}>
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
  const t    = useT()
  const href = useHref()
  const status = effectiveStatus(f)
  const approaching = status === 'Approaching'

  /*
   * Variance, and only variance.
   *
   * The panel printed a bare 06:12 where the board printed 06:12 with -13m beside it — the half
   * of the story that raises the question. Terminal, gate and belt were added here too and then
   * taken out: they added a third row to every card and this is a summary, not the board. They
   * are one tap away in the popup, which is where someone who wants them is already going.
   */
  const depDelay = calcDelay(f.dep_time_utc, f.actual_dep_utc ?? f.revised_dep_utc)
  const arrDelay = calcDelay(f.arr_time_utc, f.actual_arr_utc ?? f.revised_arr_utc)
  // Damascus keeps the brand forest it has always had here — the rail sits on a pale panel,
  // not on a map, and #16a34a would be loud against it. The provincial hubs take the marker
  // colour, which is the whole point of having one.
  const hub = markerHub(f.dep_iata, f.arr_iata)
  const railColor = hub === 'DAM' ? (approaching ? C.forest : C.forestMid) : MARKER_ACCENT[hub]

  const depOff  = tzOffset(f.dep_iata)
  const arrOff  = tzOffset(f.arr_iata)
  const depTime = fmtLocal(f.actual_dep_utc ?? f.revised_dep_utc ?? f.dep_time_utc, depOff)
  const arrMs   = etaMs(f)
  const arrTime = arrMs ? fmtLocal(new Date(arrMs).toISOString(), arrOff) : fmtLocal(f.arr_time_utc, arrOff)

  const depCity  = cityFor(f.dep_iata)
  const arrCity  = cityFor(f.arr_iata)
  const depFlag  = apFlag[f.dep_iata] ?? ''
  const arrFlag  = apFlag[f.arr_iata] ?? ''

  return (
    <Link
      href={href(`/map?flight=${encodeURIComponent(f.iata_number)}`)}
      onClick={(e) => { e.preventDefault(); onSelect(f.iata_number) }}
      style={{ display: 'block', textDecoration: 'none', background: isSelected ? '#D4EBD4' : C.surface, border: `${isSelected ? 2 : 1}px solid ${isSelected ? C.forest : C.border}`, borderRadius: 12, overflow: 'hidden', boxShadow: isSelected ? '0 6px 20px rgba(5,66,57,0.22), 0 1px 4px rgba(5,66,57,0.12)' : '0 1px 4px rgba(0,0,0,.06)', position: 'relative', transform: isSelected ? 'translateY(-1px)' : 'none', transition: 'box-shadow .2s, transform .2s, background .2s', flexShrink: 0 }}
    >
      {/* Status rail (top) */}
      <div className="ia-rail" style={{ height: 3, background: railColor }} />

      <div className="ia-body" style={{ padding: '10px 12px 11px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {/* Row 1: logo + flight info + badge */}
        <div className="ia-row1" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <MiniLogo iata={f.airline_iata} name={f.airline_name} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11.5, fontWeight: 700, color: C.ink, letterSpacing: '.05em' }}>
              {f.iata_number}{f.callsign && f.callsign !== f.iata_number ? ` · ${f.callsign}` : ''}
            </div>
            <div style={{ font: `500 10.5px/1 'Instrument Sans',system-ui`, color: C.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {airlineNameFor(f.airline_iata, f.airline_name)}
            </div>
          </div>
          <div className="ia-badge" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px 4px 6px', borderRadius: 99, background: approaching ? '#E6EFEC' : '#EBF2F1', border: `1px solid ${approaching ? '#B4CFC9' : '#BFD8D5'}`, flexShrink: 0 }}>
            <span style={{ width: 5, height: 5, borderRadius: 99, background: railColor, display: 'block' }} />
            <span style={{ font: `600 9.5px/1 'Instrument Sans',system-ui`, color: railColor, whiteSpace: 'nowrap' }}>
              {t(status === 'Departed' || status === 'En Route' ? 'status.in_air' : (STATUS_KEY[status] ?? 'status.unknown'))}
            </span>
          </div>
        </div>

        {/* Row 2: route with progress */}
        <div className="ia-row2" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Dep */}
          {/* City alone. The IATA code sat under it as a reference and has been dropped for the
              height: this card is a summary, the city is the part a reader actually reads, and
              the code is on the marker, in the popup and on the board.

              It costs one distinction — Istanbul has two airports in this schedule, IST and SAW,
              and both render as إسطنبول here. The route line in the popup still separates them. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, width: 64, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, minWidth: 0 }}>
              <span style={{ fontSize: 10, flexShrink: 0 }}>{depFlag}</span>
              <span style={{ font: `700 11px/1.15 'Instrument Sans',system-ui`, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{depCity}</span>
            </div>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, fontWeight: 700, color: C.ink, marginTop: 2 }}>{depTime}</span>
            {/* Beneath the time, not beside it: this column is 64px inside a 308px panel, where
                the board has 96px and room for both on one line. */}
            <DelayChip min={depDelay} />
          </div>

          {/* Progress */}
          {f.actual_dep_utc && f.duration_min > 0 ? (
            <MiniProgress depUtc={f.actual_dep_utc} durationMin={f.duration_min} approaching={approaching} accentColor={hub === 'DAM' ? undefined : MARKER_ACCENT[hub]} />
          ) : (
            <div style={{ flex: 1, height: 3, borderRadius: 99, background: C.trackEmpty }} />
          )}

          {/* Arr */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, width: 64, flexShrink: 0, alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, minWidth: 0 }}>
              <span style={{ font: `700 11px/1.15 'Instrument Sans',system-ui`, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{arrCity}</span>
              <span style={{ fontSize: 10, flexShrink: 0 }}>{arrFlag}</span>
            </div>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, fontWeight: 700, color: approaching ? C.forest : C.ink, marginTop: 2 }}>
              {arrTime}
              {f.arr_next_day && (
                <sup dir="ltr" style={{ fontSize: 9, fontWeight: 700, marginInlineStart: 1, color: C.forest, verticalAlign: 'super' }}>+1</sup>
              )}
            </span>
            <DelayChip min={arrDelay} />
          </div>
        </div>

      </div>
    </Link>
  )
}

// ── In-air side panel ────────────────────────────────────────────────────────
/** Shared by the desktop panel and the phone strip; only one of them is mounted at a time. */
function useInAirFlights() {
  const [flights, setFlights] = useState<InAirFlight[]>([])
  const [loading, setLoading] = useState(true)
  const [geoReady, setGeoReady] = useState(false)

  /*
   * Two days, and the live feed as a second opinion.
   *
   * A flight that leaves Dubai at 19:30 lands in Damascus after midnight, so the board files
   * it under tomorrow — the board is keyed on arrival date. Fetching today alone meant the
   * panel could not see it at all while it was in the air, which is exactly when it matters.
   *
   * Its board row is no help either: those next-day rows carry no actual_dep_utc, so the
   * status reads Scheduled or Delayed for a flight that is demonstrably flying. The map had
   * it the whole time, because markers come from the airspace feed rather than the board —
   * which is how this surfaced: an aircraft over the Gulf with no card beside it.
   *
   * So airborne is decided by either source: the board saying so, or the aircraft being in
   * the feed. Arrived still wins over both, or a flight would linger after it lands.
   */
  const load = useCallback(async () => {
    const nowMs    = Date.now()
    const dayAt    = (offsetMs: number) => new Date(nowMs + 3 * 3_600_000 + offsetMs).toISOString().slice(0, 10)
    const [today, tomorrow] = [dayAt(0), dayAt(86_400_000)]

    try {
      const [boards, live] = await Promise.all([
        Promise.all([today, tomorrow].map(d =>
          fetch(`/api/flightboard?date=${d}`).then(r => (r.ok ? r.json() : null)).catch(() => null))),
        // A failed feed must not empty the panel — it falls back to the board's own view.
        fetch('/api/airspace').then(r => (r.ok ? r.json() : null)).catch(() => null),
      ])

      const airborne = new Set<string>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((live?.aircraft ?? []) as any[])
          .map(a => String(a?.flight ?? '').trim().toUpperCase())
          .filter(Boolean),
      )

      /*
       * One row per flight. The same service appears on both days around midnight, and a
       * delayed one appears twice on the same day — once as filed and once as revised. The
       * row that knows the most wins: an actual departure first, then anything the board has
       * moved off Scheduled.
       */
      // A plain object, not a Map: `Map` at this module's scope is the dynamically imported
      // map component, so `new Map()` here builds a React element.
      const rank = (f: InAirFlight) => (f.actual_dep_utc ? 2 : f.status && f.status !== 'Scheduled' ? 1 : 0)
      const best: Record<string, InAirFlight> = {}
      for (const board of boards) {
        for (const f of ((board?.flights ?? []) as InAirFlight[])) {
          const key  = `${f.iata_number}|${f.dep_iata}|${f.arr_iata}`
          const prev = best[key]
          if (!prev || rank(f) > rank(prev)) best[key] = f
        }
      }

      const isFlying = (f: InAirFlight) => {
        const status = effectiveStatus(f)
        if (status === 'Arrived' || status === 'Cancelled') return false
        return IN_AIR.has(status)
          || airborne.has((f.callsign ?? '').toUpperCase())
          || airborne.has(f.iata_number.toUpperCase())
      }

      setFlights(Object.values(best).filter(isFlying).sort((a, b) => etaMs(a) - etaMs(b)))
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

  return { flights, loading, geoReady }
}

/**
 * Phone view of the live flights: a ticker along the bottom of the map instead of a panel
 * over it. The panel grew to fill most of a 375x812 screen once more than one flight was in
 * the air, which hid the thing people came to look at.
 *
 * Only what can be read at a glance — airline, number, both airports and both times. No
 * progress bar: the map shows position far better than a 3px track does. No cities either;
 * they do not fit at this width and the popup carries them.
 *
 * The list is rendered twice so the scroll can wrap without a visible jump back. The copy is
 * aria-hidden so it is not announced as a second set of flights.
 */
function InAirStrip({ selectedFlight, onSelect, onClear }: { selectedFlight?: string; onSelect: (n: string) => void; onClear: () => void }) {
  const t      = useT()
  const locale = useLocale()
  const { flights } = useInAirFlights()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const setRef      = useRef<HTMLDivElement>(null)
  const [looping, setLooping] = useState(false)

  // Three conditions before the strip is allowed to move.
  //
  // Overflow alone is not enough: two cards that overrun by 40px make it crawl back and
  // forth over almost nothing, which costs attention and shows nothing the half-visible
  // second card does not already advertise. Under three flights the peek is the affordance.
  //
  // Count alone is not enough either — three cards fit outright on a tablet, and moving
  // them there would be motion for its own sake.
  //
  // Selecting stops it too. A moving strip is hard to read once you have picked something
  // out of it, and with the list rendered twice the selected flight is highlighted in both
  // copies, so wrapping made the highlight appear to jump between first and second position.
  const loop = looping && flights.length >= 3 && !selectedFlight

  // Only worth animating when the cards actually overrun the screen.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const check = () => setLooping(el.scrollWidth > el.clientWidth + 8)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [flights.length])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !loop) return
    // Motion is the point — it signals there is more to see — but it must never fight a
    // finger. Any touch stops it dead and it only resumes a few seconds after release, so
    // the card you reached for is still where you saw it.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let raf = 0
    let held = false
    let resumeAt = 0
    let last = 0
    // The offset is tracked here as a float and written to the element, never read back and
    // incremented. Browsers round the stored scrollLeft, so `el.scrollLeft += 0.4` reads the
    // same integer every frame and adds to it again — the strip sits at zero and never
    // moves. Time-based rather than per-frame so the speed does not double on a 120Hz screen.
    let pos = el.scrollLeft
    // The value we last wrote, read back after writing so it matches the browser's rounding.
    // Needed to tell our own scroll events apart from the user's — see onScroll below.
    let selfScrollTo = -1
    const PX_PER_MS = 0.03
    /*
     * Which way scrollLeft runs.
     *
     * Under dir=rtl the origin is the right edge and scrollLeft goes negative, so adding to it
     * asked the browser to scroll past the start — it clamped at 0 and the strip sat still.
     * It only began moving after a touch, because the drag left scrollLeft negative and the
     * addition then had somewhere to go. English was never affected, which is why this hid.
     */
    const sign = getComputedStyle(el).direction === 'rtl' ? -1 : 1
    const tick = (t: number) => {
      const width = setRef.current?.offsetWidth ?? 0
      const dt = last ? t - last : 0
      last = t
      if (!held && t >= resumeAt && width > 0) {
        pos += sign * PX_PER_MS * dt
        if (Math.abs(pos) >= width) pos -= sign * width
        el.scrollLeft = pos
        selfScrollTo = el.scrollLeft
      } else {
        // The user is driving; pick up from wherever they left it.
        pos = el.scrollLeft
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const hold    = () => { held = true }
    const release = () => { held = false; resumeAt = performance.now() + 3500 }
    el.addEventListener('pointerdown', hold)
    el.addEventListener('pointerup', release)
    el.addEventListener('pointercancel', release)
    el.addEventListener('pointerleave', release)
    // A swipe is momentum scrolling that keeps firing after the finger is gone, so the timer
    // restarts on scroll rather than only on release — but writing scrollLeft fires this same
    // event. Without the guard the loop re-armed its own cooldown every frame and advanced
    // ~0.4px every 3.5s, which reads as completely still.
    const onScroll = () => {
      if (held) return
      if (Math.abs(el.scrollLeft - selfScrollTo) <= 2) return
      resumeAt = performance.now() + 3500
    }
    el.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('pointerdown', hold)
      el.removeEventListener('pointerup', release)
      el.removeEventListener('pointercancel', release)
      el.removeEventListener('pointerleave', release)
      el.removeEventListener('scroll', onScroll)
    }
  }, [loop, flights.length])

  // Removing the duplicate can leave the scroll parked past the end of what remains, and
  // the card you just tapped may be off-screen anyway. Put it back in view.
  useEffect(() => {
    if (!selectedFlight) return
    const card = scrollerRef.current?.querySelector(`[data-flight="${CSS.escape(selectedFlight)}"]`)
    card?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [selectedFlight, flights.length])

  if (flights.length === 0) return null

  const cards = (ghost: boolean) => (
    <div ref={ghost ? undefined : setRef} aria-hidden={ghost} style={{ display: 'flex', gap: 8, paddingInlineEnd: 8 }}>
      {flights.map((f) => {
        const selected = f.iata_number === selectedFlight
        const depOff = tzOffset(f.dep_iata)
        const arrOff = tzOffset(f.arr_iata)
        const depTime = fmtLocal(f.actual_dep_utc ?? f.revised_dep_utc ?? f.dep_time_utc, depOff)
        const arrMs   = etaMs(f)
        const arrTime = arrMs ? fmtLocal(new Date(arrMs).toISOString(), arrOff) : fmtLocal(f.arr_time_utc, arrOff)
        // Which end is home decides whether the other end is a destination or an origin.
        // Read from the flag rather than a hardcoded airport list: DEZ is due to open and
        // Latakia and Qamishli come and go, and a stale list would silently label those
        // flights backwards. Every flight here has exactly one Syrian end.
        // The same variance the board and the desktop card show. Only these two numbers, not the
        // whole meta strip: this is a horizontal scroller sized to peek the next card, and four
        // more labels would make it a card rather than a strip. The detail is one tap away.
        const depDelay = calcDelay(f.dep_time_utc, f.actual_dep_utc ?? f.revised_dep_utc)
        const arrDelay = calcDelay(f.arr_time_utc, f.actual_arr_utc ?? f.revised_arr_utc)
        const outbound = (apFlag[f.dep_iata] ?? '') === '🇸🇾'
        const otherIata = outbound ? f.arr_iata : f.dep_iata
        const otherCity = cityFor(otherIata)
        // Same rule as the desktop card and the map's plane markers, so the strip and the map
        // agree at a glance. It was a boolean, which quietly gave Deir ez-Zor the Damascus rail.
        const hub = markerHub(f.dep_iata, f.arr_iata)
        const railColor = hub === 'DAM' ? C.forestMid : MARKER_ACCENT[hub]
        return (
          <button
            key={`${ghost ? 'g' : ''}${f.iata_number}-${f.dep_iata}-${f.arr_iata}`}
            onClick={() => (selected ? onClear() : onSelect(f.iata_number))}
            aria-label={`${f.iata_number} — ${cityFor(f.dep_iata)} ${locale === 'ar' ? '←' : '→'} ${cityFor(f.arr_iata)}`}
            data-flight={ghost ? undefined : f.iata_number}
            style={{
              flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'stretch',
              padding: 0, borderRadius: 12, overflow: 'hidden', cursor: 'pointer', textAlign: 'start',
              background: selected ? '#D4EBD4' : 'rgba(255,255,255,0.94)',
              border: `${selected ? 2 : 1}px solid ${selected ? C.forest : C.border}`,
              backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
              boxShadow: '0 2px 10px rgba(0,0,0,.12)',
            }}
          >
            <span style={{ height: 3, background: railColor, display: 'block', flexShrink: 0 }} />
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 11px 8px' }}>
            <MiniLogo iata={f.airline_iata} name={f.airline_name} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, whiteSpace: 'nowrap' }}>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11.5, fontWeight: 700, color: C.ink, letterSpacing: '.04em' }}>
                  {f.iata_number}
                </span>
                <span style={{ font: `500 11px/1 'Instrument Sans',system-ui`, color: C.muted }}>
                  {t(outbound ? 'map.to' : 'map.from')} <span style={{ fontWeight: 700, color: C.ink }}>{otherCity}</span>
                </span>
              </span>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10.5, fontWeight: 600, color: C.muted, whiteSpace: 'nowrap' }}>
                {f.dep_iata} {depTime}{depDelay ? <> <DelayChip min={depDelay} /></> : null}
                {' '}<span style={{ color: C.forestLight }}>{locale === 'ar' ? '←' : '→'}</span>{' '}
                {f.arr_iata} {arrTime}{arrDelay ? <> <DelayChip min={arrDelay} /></> : null}
              </span>
            </span>
            </span>
          </button>
        )
      })}
    </div>
  )

  return (
    <>
      {/* Just the count. The old pill carried "N in air" beside it, but the strip below now
          says what these are, so the words were repeating themselves. Sits top-left, the
          corner the map credit vacated on phones. */}
      <div style={{
        position: 'absolute', left: 12, top: 12, zIndex: 1000,
        minWidth: 30, height: 26, paddingLeft: 9, paddingRight: 9, borderRadius: 99,
        background: C.forest, display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 2px 10px rgba(0,0,0,.18)',
      }}>
        <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, fontWeight: 700, color: '#fff', lineHeight: 1 }}>
          {flights.length}
        </span>
      </div>

    <div style={{
      position: 'absolute', left: 0, right: 0, zIndex: 1000,
      bottom: 'env(safe-area-inset-bottom)',
    }}>
      <div
        ref={scrollerRef}
        className="ia-strip"
        style={{ display: 'flex', overflowX: 'auto', padding: '0 12px' }}
      >
        {cards(false)}
        {loop && cards(true)}
      </div>
    </div>
    </>
  )
}

function InAirPanel({ selectedFlight, open, setOpen, onSelect, onClear }: { selectedFlight?: string; open: boolean; setOpen: (v: boolean) => void; onSelect: (n: string) => void; onClear: () => void }) {
  const t      = useT()
  const locale = useLocale()
  const { flights, loading } = useInAirFlights()
  const count = flights.length

  // ── Closed: pill FAB ─────────────────────────────────────────────────────
  if (!open) {
    return (
      /* Physical left, not inset-inline-start. The map overlays are placed against the map,
         not against the text: Syria sits centre-right in the default view, so a panel that
         mirrored into the right-hand side in Arabic would cover the country it is describing.
         Reading direction is the wrong thing to hang this on. */
      <div style={{ position: 'absolute', left: 12, bottom: 96, zIndex: 1000, display: 'flex', alignItems: 'center', gap: 8 }}>
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
          {loading ? t('label.loading') : count === 0 ? t('map.no_flights') : `${counted(locale, count, 'noun.flight')} ${t('chip.in_air')}`}
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={count > 0 ? '#fff' : C.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m18 15-6-6-6 6"/>
        </svg>
      </button>
      {/* Selecting a flight collapses the panel on phones, which is where you are looking
          right after you select one — so the header's Clear button is exactly the thing you
          cannot reach. Repeat it here, naming the flight so it is obvious what is selected. */}
      {selectedFlight && (
        <button
          onClick={onClear}
          aria-label={`${t('action.clear')} ${selectedFlight}`}
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
      // Left in both languages — see the note on the collapsed pill above.
      position: 'absolute', left: 12, bottom: 'calc(30px + env(safe-area-inset-bottom))', zIndex: 999,
      width: 'min(308px, calc(88vw - 12px))',
      maxHeight: 'calc(100% - 54px - env(safe-area-inset-bottom))',
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
            <span style={{ font: `700 13.5px/1 'Instrument Sans',system-ui`, color: C.ink }}>{t('map.panel_title')}</span>
          </div>
          <span style={{ font: `500 10.5px/1 'Instrument Sans',system-ui`, color: C.muted, marginTop: 5, display: 'block' }}>
            {loading ? t('label.loading') : `${counted(locale, count, 'noun.flight')} · ${t('map.sorted')}`}
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
            aria-label={t('action.clear_selected')}
            style={{
              height: 28, borderRadius: 8, border: `1px solid ${C.border}`, background: C.sunken,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, color: C.muted, padding: '0 9px',
              font: `600 11px/1 'Instrument Sans',system-ui`, whiteSpace: 'nowrap',
            }}
          >
            {t('action.clear')}
          </button>
        )}
        <button
          onClick={() => setOpen(false)}
          aria-label={t('action.close_panel')}
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
            <span style={{ font: `500 11px/1 'Instrument Sans',system-ui`, color: C.muted }}>{t('label.loading')}</span>
          </div>
        )}
        {!loading && count === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 0', gap: 10, textAlign: 'center' }}>
            <span style={{ fontSize: 36 }}>✈</span>
            <span style={{ font: `600 12.5px/1.4 'Instrument Sans',system-ui`, color: C.muted }}>{t('map.none_currently')}</span>
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

  // The panel and the strip are different components, not one component restyled, so the
  // breakpoint is read in JS. Tracked rather than sampled once: a one-shot read at mount can
  // land before the viewport settles at its real width.
  const [isPhone, setIsPhone] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(PHONE_MQ)
    const apply = () => setIsPhone(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

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
        .ia-strip { scrollbar-width: none; -ms-overflow-style: none; -webkit-overflow-scrolling: touch; }
        .ia-strip::-webkit-scrollbar { display: none; }
        .fab-pill { animation: fab-attract 6s 1s infinite; transition: transform .15s ease, box-shadow .15s ease; }
        .fab-pill:hover { transform: translateY(-2px) scale(1.04) !important; box-shadow: 0 6px 22px rgba(0,0,0,.28) !important; animation-play-state: paused; }
        /* The in-air cards were built for the desktop panel. On a phone the same panel is a
           much larger share of the screen, so the card is tightened: less padding, smaller
           logo and badge, tighter rows. Nothing is removed — every field a card carried at
           full size it still carries here, it just costs fewer pixels. */
        @media (max-width: 767px) {
          .ia-rail  { height: 2px !important; }
          .ia-body  { padding: 7px 10px 8px !important; gap: 6px !important; }
          .ia-row1  { gap: 7px !important; }
          .ia-row1 > div:first-of-type,
          .ia-row1 img { width: 26px !important; height: 26px !important; }
          .ia-badge { padding: 3px 7px 3px 5px !important; }
          .ia-row2  { gap: 7px !important; }
        }
      `}</style>

      <SiteNav active="Track" />

      {/* Map area */}
      <main style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <Map targetFlight={flight} panelOpen={panelOpen} />

        {/* In-air side panel */}
        {isPhone
          ? <InAirStrip selectedFlight={flight} onSelect={selectFlight} onClear={clearFlight} />
          : <InAirPanel selectedFlight={flight} open={panelOpen} setOpen={setPanelOpen} onSelect={selectFlight} onClear={clearFlight} />}

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

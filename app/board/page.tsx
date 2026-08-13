'use client'

import { useEffect, useState, useCallback, useRef, Fragment } from 'react'
import Link from 'next/link'
import { AIRLINE_LOGOS, LOGO_WHITE_BG } from '@/lib/airlines'
import { airportCity, cityFor, airlineNameFor, airportFlag as _apFlag, airportOffset, loadGeoData } from '@/lib/geo-data'
import SiteNav from '@/components/SiteNav'
import LanguageSwitch from '@/components/LanguageSwitch'
import { useT, useLocale, useHref } from '@/components/LocaleProvider'
import { STATUS_KEY, counted, dateLocaleOf, type Locale } from '@/lib/i18n'
import { BOARD_AIRPORTS, type BoardAirport } from '@/lib/syria-airports'

const city = (iata: string) => cityFor(iata)
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
  /** ADS-B broadcast callsign (SYR516) — what the aircraft transmits, not what the ticket says. */
  callsign: string | null
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
  /** The arrival lands on the day after this board's date — shown as +1 beside the time. */
  arr_next_day?: boolean
}

type Tab     = -1 | 0 | 1
type View    = 'arr' | 'dep'
// The board filters purely on dep_iata/arr_iata, so the shared list drives both the tabs
// and the cache warm loop below. Destinations and airlines read the same list.
type Airport = BoardAirport

const AIRPORTS: readonly Airport[] = BOARD_AIRPORTS.map(a => a.iata)

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

// Arabic carries no English unit letters — see the twin in FlightDetail.
function durationLabel(min: number, locale: Locale): string {
  if (!min) return ''
  const h = Math.floor(min / 60), m = min % 60
  if (locale === 'ar') {
    /*
     * Spelled out, because `1:03` in Arabic reads as a clock time rather than a duration — and
     * this string sits next to real clock times on the same card, so a reader has nothing to tell
     * them apart. The app has always spelled it out and its comment claimed "same rule as the
     * web's twin"; the twin had drifted, and said 1:03 على الوصول where the app said
     * ١ ساعة و٣ دقائق على الوصول.
     *
     * The dual is marked on the noun — ساعتان *is* "two hours" — which counted() handles by
     * dropping the numeral at two, so this cannot say the 2 twice.
     */
    if (h > 0) {
      const hours = counted('ar', h, 'noun.hour')
      return m > 0 ? `${hours} و${counted('ar', m, 'noun.minute')}` : hours
    }
    return counted('ar', m, 'noun.minute')
  }
  // No leading "0h" under an hour — see the twin on the map.
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/*
 * Hours and minutes, for the flown time on an arrived card.
 *
 * Separate from durationLabel, which renders "3h 40m" in English and switches format under an
 * hour. The app keeps the same two helpers apart for the same reason: this number sits under a
 * label, where "Flight time 2:15" reads as a clock and "Flight time 2h 15m" reads twice.
 */
function hhmm(min: number): string {
  return `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`
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

/*
 * Minutes into the board's day — which can exceed 1440.
 *
 * Both branches used to wrap at midnight, so a flight due 21:50 and delayed to 00:05 sorted
 * as 5: first in the list, above the 01:00 arrivals, and on the wrong side of the now-line
 * as if it had landed this morning. It was on the board the whole time and nowhere anyone
 * would look for it, which is the same mistake the +1 marker exists to prevent, made in the
 * ordering instead of the digits.
 *
 * A spilled arrival keeps counting past 1440 so it sorts after the evening it belongs to.
 */
function effectiveLocalMin(f: Flight, v: View): number {
  const spill = v === 'arr' && f.arr_next_day ? 1440 : 0
  const iso = v === 'arr'
    ? (f.actual_arr_utc ?? f.revised_arr_utc)
    : (f.actual_dep_utc ?? f.revised_dep_utc)
  if (iso) {
    const localMs = new Date(iso).getTime() + 3 * 3_600_000
    const d = new Date(localMs)
    return d.getUTCHours() * 60 + d.getUTCMinutes() + spill
  }
  const hhmm = v === 'arr' ? f.arr_time_utc : f.dep_time_utc
  if (!hhmm) return 0
  const [h, m] = hhmm.split(':').map(Number)
  return ((h * 60 + m + 3 * 60) % 1440) + spill
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
  const locale = useLocale()
  const t      = useT()
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
        {remainingMin > 0 ? `${durationLabel(remainingMin, locale)} ${t('label.left')}` : t('label.arriving')}
      </span>
      <div style={{ display: 'flex', flexDirection: 'row', width: '100%', alignItems: 'center', height: 20 }}>
        <div style={{ flex: fill, height: 4, borderRadius: 99, background: C.forestMid }} />
        <div style={{
          width: 18, height: 18, borderRadius: 9, background: C.surface, flexShrink: 0,
          border: `1.5px solid ${C.forestMid}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: `0 2px 5px rgba(66,129,119,.35)`,
        }}>
          {/*
            The marker is the aircraft, so it points the way it is travelling — and that
            reverses with the script: the bar fills left-to-right in English and
            right-to-left in Arabic, so a fixed direction has the plane flying backwards in
            one of them. The path is drawn nose-up and rotated.
          */}
          <svg width="10" height="10" viewBox="0 0 24 24" fill={C.forestMid} aria-hidden
               style={{ transform: `rotate(${locale === 'ar' ? -90 : 90}deg)` }}>
            <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
          </svg>
        </div>
        <div style={{ flex: empty, height: 4, borderRadius: 99, background: C.trackEmpty }} />
      </div>
    </div>
  )
}

// ── Arrived route ─────────────────────────────────────────────────────────────
function ArrivedRoute({ durationMin }: { durationMin: number }) {
  const t      = useT()
  const locale = useLocale()   // still read below, for which way the plane points
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      {/*
        Labelled, and in the track's own colour — both copied from the app, whose comment gives
        the reason: once a flight is down, "Arrived" only repeats the status badge and the filled
        bar, so how long it took is the one thing the card cannot otherwise tell you.

        The web printed the bare number. "2:15" under a finished bar could be the block time, the
        time it landed, or anything else; the label is what makes it an answer.
      */}
      {durationMin > 0 && (
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: C.forestMid, whiteSpace: 'nowrap' }}>
          {t('label.flight_time')} {hhmm(durationMin)}
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
          <svg width="10" height="10" viewBox="0 0 24 24" fill={C.forest} aria-hidden
               style={{ transform: `rotate(${locale === 'ar' ? -90 : 90}deg)` }}>
            <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
          </svg>
        </div>
      </div>
    </div>
  )
}

// ── Status badge ──────────────────────────────────────────────────────────────
/**
 * Where the flight is right now, when a live fix can say — otherwise the status badge.
 *
 * Mirrors the app's PhaseChip, including the parts that look like details and are not:
 *
 * The airborne pair has no strings of its own. It reads status.departed / status.in_air from the
 * dictionary the rest of the site already uses, because the alternative is a fourth word for one
 * state. Which of the two depends on the board: on arrivals the fact a reader wants is that it is
 * still coming (في الجو); on departures, that it has gone (أقلعت).
 *
 * An unrecognised phase renders nothing and the caller keeps the status badge. That is the rule
 * that lets the server introduce a phase later without a web deploy — the same contract the app
 * relies on for a build already on someone's phone.
 *
 * Only the phases a reader acts on get colour. A board where every chip shouts tells you nothing;
 * the point is that "at the gate" stands out from "scheduled".
 */
const PHASE_KEY: Record<string, string> = {
  taxiing:      'phase.taxiing',
  landed:       'phase.landed',
  taxi_to_gate: 'phase.taxi_to_gate',
  at_gate:      'phase.at_gate',
  bags_on_belt: 'phase.bags_on_belt',
  cancelled:    'status.cancelled',
  scheduled:    'status.scheduled',
}
const PHASE_AIRBORNE = new Set(['departed', 'en_route'])
const PHASE_TONE: Record<string, { bg: string; fg: string }> = {
  taxiing:      { bg: '#EAF2FB', fg: '#1B4F87' },
  departed:     { bg: '#EAF2FB', fg: '#1B4F87' },
  en_route:     { bg: '#EAF2FB', fg: '#1B4F87' },
  landed:       { bg: '#E9F3EC', fg: '#215E37' },
  taxi_to_gate: { bg: '#E9F3EC', fg: '#215E37' },
  at_gate:      { bg: '#E9F3EC', fg: '#215E37' },
  bags_on_belt: { bg: '#E9F3EC', fg: '#215E37' },
  cancelled:    { bg: '#FBECEC', fg: '#8A2B2B' },
  scheduled:    { bg: '#EFEEE8', fg: '#5C5A52' },
}

/**
 * Whether a phase is one this build knows how to name.
 *
 * The caller needs this to choose between the chip and the status badge, and it must be the same
 * test the chip applies — an unknown phase has to fall back to the badge, not leave a blank space
 * where a status used to be.
 */
function hasPhase(phase: string | null | undefined): boolean {
  return !!phase && (phase in PHASE_KEY || PHASE_AIRBORNE.has(phase))
}

function PhaseChip({ phase, view }: { phase: string | null | undefined; view?: View }) {
  const t = useT()
  if (!phase) return null
  const airborne = PHASE_AIRBORNE.has(phase)
  const key = PHASE_KEY[phase]
  if (!key && !airborne) return null
  const tone = PHASE_TONE[phase] ?? PHASE_TONE.scheduled
  const word = airborne
    ? t(view === 'dep' ? 'status.departed' : 'status.in_air')
    : t(key)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', flexShrink: 0,
      padding: '5px 11px', borderRadius: 999, background: tone.bg,
    }}>
      <span style={{ font: `600 11.5px/1 'Instrument Sans', system-ui`, color: tone.fg, whiteSpace: 'nowrap' }}>
        {word}
      </span>
    </div>
  )
}

function StatusBadge({ status, view }: { status: string; view?: View }) {
  const t = useT()
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
        {/* The English label stays as the fallback for a status with no mapping — better a
            word the reader may not know than an empty badge. */}
        {STATUS_KEY[status] ? t(STATUS_KEY[status]) : cfg.label}
      </span>
    </div>
  )
}

// ── Delay chip ────────────────────────────────────────────────────────────────
/**
 * The small print under the rail: aircraft type, terminal, gate, belt.
 *
 * No separator characters at all. The app joins these with middots, and this column is too narrow
 * to copy that: between two 96px time columns the strip gets 89px on a 375px screen, so "Terminal
 * 3" always wraps below the type. Any middot then leads the wrapped line and reads as a fault —
 * which it did twice, first from a joined string and then from separators bound to the item that
 * follows them, so they wrapped along with it.
 *
 * Whitespace separates instead. Every label but the aircraft type already carries its own noun
 * ("Terminal 3", "Gate B1"), so nothing is lost, and a wrap simply produces a second centred row.
 *
 * Renders nothing when it has nothing — most flights carry a type and no more, and an empty row
 * would add height to all 38 cards to say nothing on most of them.
 *
 * No dir override. It carried dir="ltr" at first, to keep the Latin aircraft code upright — which
 * it never needed, since a Latin run renders left-to-right inside an RTL paragraph on its own.
 * What the override did do was pin the item order to left-to-right on an Arabic page, so a reader
 * scanning right-to-left met them backwards: حقائب 3، then مبنى 3، then the type. Inheriting the
 * page direction puts them in the order they are written in, both ways round.
 */
function MetaStrip({ items }: { items: { text: string | null | undefined; cls?: string }[] }) {
  const parts = items
    .map(i => ({ ...i, text: (i.text ?? '').trim() }))
    .filter(i => i.text)
  if (!parts.length) return null
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'baseline',
      gap: '2px 10px', maxWidth: '100%',
    }}>
      {parts.map((p, i) => (
        <span key={p.text + i} className={p.cls} style={{
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: C.muted,
          letterSpacing: '.04em', whiteSpace: 'nowrap',
        }}>{p.text}</span>
      ))}
    </div>
  )
}

function DelayChip({ min }: { min: number | null }) {
  const locale = useLocale()
  if (!min || Math.abs(min) < 1) return null
  const isLate = min > 0
  const unit   = locale === 'ar' ? 'د' : 'm'
  /*
   * Three elements, not one string, and dir=ltr on the wrapper.
   *
   * Bidi will not lay this out: under dir=rtl it puts the Arabic letter rightmost and drops
   * the lone sign at the far left, so "+6د" and "د6+" rendered identically. Separate spans in
   * a flex row are positioned by DOM order alone, which is the only way to pin unit, number,
   * sign and keep it pinned for a minus or a three-digit delay.
   */
  return (
    <span dir="ltr" style={{ display: 'inline-flex',
      fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600,
      padding: '3px 5px', borderRadius: 5, lineHeight: 1,
      background: isLate ? C.wineBg : '#E6EFEC',
      color: isLate ? C.wineText : '#002623',
    }}>
      {locale === 'ar' ? (
        <>
          <span>{unit}</span><span>{Math.abs(min)}</span><span>{isLate ? '+' : '-'}</span>
        </>
      ) : (isLate ? `+${min}${unit}` : `${min}${unit}`)}
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
/*
 * `boardDate` is the day this card was read off, and it travels with the link.
 *
 * Without it, tapping Share on a Yesterday card opened today's service: /api/flight searches
 * today first and returns the first match, so the same number on two days always resolves to
 * the later one. Only sent when it is not today — a link to a flight happening now should
 * stay live rather than freeze to a date.
 */
function FlightCard({ f, view, isPinned, onTogglePin, boardDate, phase }: { f: Flight; view: View; isPinned: boolean; onTogglePin: () => void; boardDate?: string; phase?: string | null }) {
  const t      = useT()
  const href   = useHref()
  const locale = useLocale()
  const isArr   = view === 'arr'
  const status  = effectiveStatus(f)
  const cfg     = STATUS[status] ?? STATUS.Unknown
  const isCancelled = status === 'Cancelled'
  // Not showArrived below: that one also requires a duration, because it gates a progress
  // bar. The belt only needs the flight to be down.
  const isArrived   = status === 'Arrived'

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

  /*
   * One label for both ends, because only one is ever populated — the foreign airport's.
   * Damascus and Aleppo do not publish a terminal, so "Terminal 3 / —" would be a column of
   * blanks; joining whichever side has a value says the same thing in the space of a word.
   * The app derives it identically, and the two must agree because a passenger reads one and
   * then the other.
   */
  const terminalLabel = (() => {
    const parts = [f.dep_terminal, f.arr_terminal].map(v => (v ?? '').trim()).filter(Boolean)
    return parts.length ? `${t('label.terminal')} ${parts.join(' / ')}` : null
  })()

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
            /*
              Smaller and looser in Arabic. Cairo sits taller in its em than the Latin face, so
              14.5px on a 1.1 line-height clipped the tops of the letters — the tighter the
              leading, the more it takes off. The Latin sizing is unchanged.
            */
            font: locale === 'ar'
              ? `600 13.5px/1.45 'Instrument Sans', system-ui`
              : `600 14.5px/1.1 'Instrument Sans', system-ui`,
            color: C.ink,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            textDecoration: isCancelled ? 'line-through' : 'none',
            textDecorationColor: '#C4BEAE',
          }}>
            {airlineNameFor(f.airline_iata, f.airline_name)}
          </span>
          {/*
            * Ticket number, then callsign, then the airframe in brackets:
            *
            *   RB516 · SYR516 (A320)
            *
            * The two identifiers are genuinely different things and both get looked up. The
            * IATA number is on the boarding pass; the callsign is what the aircraft transmits
            * and what every tracking site keys on, so it is the one to type into FR24. The
            * mismatch between them has been the root of several bugs here, which is a decent
            * sign it is worth showing rather than hiding.
            *
            * Omitted when it merely repeats the flight number — some operators broadcast the
            * IATA number verbatim, and "XY592 · XY592" reads as a rendering fault.
            */}
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.muted, letterSpacing: '.07em' }}>
            {f.iata_number}
            {f.callsign && f.callsign !== f.iata_number ? ` · ${f.callsign}` : ''}
          </span>
        </div>

        {/* The live phase when we have one we understand, the board's own status otherwise.
            hasPhase is the same test PhaseChip makes internally — exposed so the fallback is
            decided here rather than by rendering the chip and inspecting the result. */}
        {hasPhase(phase)
          ? <PhaseChip phase={phase} view={view} />
          : <StatusBadge status={status} view={view} />}
      </div>

      {/* Footer */}
      <div style={{ borderTop: `1px dashed ${C.separator}`, background: C.sunken, padding: '13px 16px 15px 20px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>

        {/* Dep */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 96, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 13, flexShrink: 0 }}>{airportFlag(f.dep_iata)}</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              <span style={{ font: `600 13px/1.1 'Instrument Sans', system-ui`, color: isCancelled ? C.secondary : C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {city(f.dep_iata)}
              </span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.muted, letterSpacing: '.06em' }}>{f.dep_iata}</span>
            </div>
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

        {/*
          Middle: the track, and under it the small print about the journey.
          
          The strip sits below the rail rather than beside the flight number, matching the app:
          that line is what a flight is looked up by, and the aircraft type, terminal, gate and
          belt are facts about this particular journey. Appending the terminal to the identity
          line was my first attempt and it was wrong twice over — it read as part of the flight's
          name, and at 375px it overflowed a 172px box and wrapped to a second line led by an
          orphaned middot, which looks like a rendering fault.

          Which end the terminal refers to is never ambiguous: only one end ever has one. Every
          terminal published on 13 Aug was at the foreign airport, because DAM, ALP and DEZ
          publish none — so it is always the airport that is not in Syria.

          Wrapping is centred and the separators are their own elements, so a wrapped line reads
          as a second row of labels rather than a stray character.
        */}
        {/*
          alignItems is stretch, not center. ProgressRoute and ArrivedRoute are separate
          components carrying `flex: 1`, which stretched them while this column was a row child.
          Wrapping them in a centred column made that `flex: 1` mean vertical growth instead, and
          left their width to shrink to content — so the rail, sized `width: 100%`, collapsed to a
          stub beside the plane. MetaStrip centres its own contents, so nothing needs centring here.
        */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
        {isCancelled ? (
          <div style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 5 }}>
            <span style={{ font: `500 11px/1 'Instrument Sans', system-ui`, color: C.muted, textAlign: 'center' }}>
              {t('status.cancelled')}
            </span>
          </div>
        ) : showProgress && depForProgress ? (
          <ProgressRoute depUtc={depForProgress} durationMin={f.duration_min} />
        ) : showArrived ? (
          <ArrivedRoute durationMin={f.duration_min} />
        ) : (
          <div style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, paddingTop: 5 }}>
            {f.duration_min > 0 && (
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: C.muted, whiteSpace: 'nowrap' }}>
                {durationLabel(f.duration_min, locale)}
              </span>
            )}
            {/*
              A plane at the origin end of an empty track.
              User feedback: on a scheduled flight the bar was a plain line, and nothing on the
              card said which way the journey runs — the two airports read as a pair rather
              than an order. The marker is the same one the departed and arrived states use, in
              a muted colour because the flight has not left, and flexDirection row puts it at
              the origin in both scripts.
            */}
            <div style={{ display: 'flex', flexDirection: 'row', width: '100%', alignItems: 'center', height: 18 }}>
              <div style={{
                width: 18, height: 18, borderRadius: 9, background: C.surface, flexShrink: 0,
                border: `1.5px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill={C.muted} aria-hidden
                     style={{ transform: `rotate(${locale === 'ar' ? -90 : 90}deg)` }}>
                  <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
                </svg>
              </div>
              <div style={{ flex: 1, height: 4, borderRadius: 99, background: C.trackEmpty }} />
            </div>
          </div>
        )}
        <MetaStrip
          items={[
            // Desktop only. On a phone this column is 89px wide, so the type pushed the terminal
            // onto a second line on every card that had one — and of the four labels here it is
            // the one nobody is looking for. The others are things a passenger acts on.
            { text: f.aircraft_type, cls: 'ft-ac-type' },
            { text: terminalLabel },
            { text: (isArr ? f.arr_gate : f.dep_gate) ? `${t('label.gate')} ${isArr ? f.arr_gate : f.dep_gate}` : null },
            // Gated on Arrived: a belt against a flight still in the air is the cache's old
            // habit of republishing one from an earlier instance of the same number.
            { text: f.arr_baggage && isArrived && !isCancelled ? `${t('label.belt')} ${f.arr_baggage}` : null },
          ]}
        />
        </div>

        {/* Arr */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 96, alignItems: 'flex-end', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 13, flexShrink: 0 }}>{airportFlag(f.arr_iata)}</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-end', minWidth: 0 }}>
              <span style={{ font: `600 13px/1.1 'Instrument Sans', system-ui`, color: isCancelled ? C.secondary : C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {city(f.arr_iata)}
              </span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.muted, letterSpacing: '.06em' }}>{f.arr_iata}</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            {/* Not gated to the arrivals board. The card prints an arrival time on both, and a
                revised time without its variance is the half of the story that raises the
                question — SYR515 read 10:49 against a filed 11:04 and said nothing about the
                fifteen minutes, while the map's flight sheet showed the chip all along. */}
            {!isCancelled && <DelayChip min={arrDelay} />}
            {hasComputedETA && !isCancelled && (
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, padding: '3px 5px', borderRadius: 5, background: C.goldenBg, color: C.goldenText }}>~</span>
            )}
            <span style={{
              font: `600 20px/1 'IBM Plex Mono', monospace`,
              color: isCancelled ? '#A6A093' : arrTimeColor,
              textDecoration: isCancelled ? 'line-through' : 'none',
            }}>
              {hasComputedETA && !isCancelled ? fmtLocal(computedETA(f), arrOff) : arrTime}
              {/*
                The timetable +1: this flight was due today and lands after midnight. Without
                it, 00:05 sits in a column of evening times and reads as ten past midnight
                this morning — a full day out. Superscript rather than a separate chip so it
                stays attached to the digits it qualifies, and dir=ltr because bidi otherwise
                throws the + to the far side of the token.
              */}
              {f.arr_next_day && !isCancelled && (
                <sup dir="ltr" title={t('label.next_day')} style={{ fontSize: 11, fontWeight: 700, marginInlineStart: 1, color: C.goldenText, textDecoration: 'none', verticalAlign: 'super' }}>+1</sup>
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Action strip */}
      <div style={{ borderTop: `1px solid ${C.trackEmpty}`, padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Link href={href(`/flight/${encodeURIComponent(f.iata_number)}${boardDate ? `?date=${boardDate}` : ''}`)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 99, background: C.sunken, border: `1px solid ${C.border}`, color: C.secondary, fontSize: 11, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap', fontFamily: "'Instrument Sans', system-ui" }}>
            <svg width={12} height={12} viewBox="0 0 16 16" fill="none">
              <circle cx="12" cy="3" r="1.8" stroke="currentColor" strokeWidth="1.5"/>
              <circle cx="12" cy="13" r="1.8" stroke="currentColor" strokeWidth="1.5"/>
              <circle cx="3" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="10.3" y1="3.9" x2="4.7" y2="7.1" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="4.7" y1="8.9" x2="10.3" y2="12.1" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
            {t('action.share')}
          </Link>
          <button onClick={onTogglePin} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 99, background: isPinned ? C.forest : C.sunken, border: `1px solid ${isPinned ? C.forest : C.border}`, color: isPinned ? '#fff' : C.secondary, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: "'Instrument Sans', system-ui", whiteSpace: 'nowrap' }}>
            <PinSVG />
            {t(isPinned ? 'action.pinned' : 'action.pin')}
          </button>
        </div>
        {showTrack && (
          <Link
            href={href(`/map?flight=${encodeURIComponent(f.iata_number)}`)}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 11px', borderRadius: 99, background: C.forest, color: '#fff', fontSize: 11, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap', fontFamily: "'Instrument Sans', system-ui" }}
          >
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>
            </svg>
            {t('nav.track_button')}
          </Link>
        )}
      </div>
    </div>
  )
}

// ── Region classification ────────────────────────────────────────────────────
const REGION: Record<string, string> = {
  // UAE
  DXB: 'Middle East', SHJ: 'Middle East', AUH: 'Middle East',
  // Gulf
  KWI: 'Middle East', BAH: 'Middle East', DOH: 'Middle East', MCT: 'Middle East',
  // Iraq
  BGW: 'Middle East', BSR: 'Middle East', NJF: 'Middle East', EBL: 'Middle East', ISU: 'Middle East',
  // Levant + North Africa
  AMM: 'Middle East', BEY: 'Middle East',
  MJI: 'Middle East', TIP: 'Middle East',
  // Egypt
  CAI: 'Middle East', HRG: 'Middle East', SSH: 'Middle East', RMF: 'Middle East',
  // Saudi Arabia
  RUH: 'Middle East', JED: 'Middle East', MED: 'Middle East', DMM: 'Middle East', TIF: 'Middle East',
  // Iran
  IKA: 'Middle East', MHD: 'Middle East', TBZ: 'Middle East', KIH: 'Middle East', AWZ: 'Middle East',
  // Turkey
  IST: 'Europe', SAW: 'Europe', AYT: 'Europe', ESB: 'Europe',
  // Germany
  BER: 'Europe', FRA: 'Europe', MUC: 'Europe', HAM: 'Europe', DUS: 'Europe', STR: 'Europe', CGN: 'Europe',
  // Netherlands
  AMS: 'Europe', EIN: 'Europe',
  // France
  CDG: 'Europe', ORY: 'Europe', LYS: 'Europe', NCE: 'Europe',
  // UK
  LHR: 'Europe', LGW: 'Europe', STN: 'Europe', MAN: 'Europe', BHX: 'Europe', EDI: 'Europe',
  // Scandinavia
  ARN: 'Europe', GOT: 'Europe', OSL: 'Europe', CPH: 'Europe', HEL: 'Europe',
  // Austria / Switzerland
  VIE: 'Europe', ZRH: 'Europe', GVA: 'Europe', BSL: 'Europe',
  // Italy
  FCO: 'Europe', MXP: 'Europe', VCE: 'Europe', CIA: 'Europe', BGY: 'Europe', NAP: 'Europe',
  // Spain / Portugal
  BCN: 'Europe', MAD: 'Europe', PMI: 'Europe', LIS: 'Europe',
  // Greece
  ATH: 'Europe', HER: 'Europe', SKG: 'Europe',
  // Eastern Europe
  PRG: 'Europe', WAW: 'Europe', KRK: 'Europe', BRU: 'Europe',
  OTP: 'Europe', CLJ: 'Europe', BUD: 'Europe', SOF: 'Europe', SKP: 'Europe',
  ZAG: 'Europe', LJU: 'Europe', KBP: 'Europe',
}
const REGION_ORDER = ['Middle East', 'Europe', 'Other']

/** Grouping key → dictionary key. The keys above are data, not display text. */
const REGION_KEY: Record<string, string> = {
  'Middle East': 'region.middle_east',
  Europe:        'region.europe_full',
  Other:         'region.other',
}

// ── Tab date label ────────────────────────────────────────────────────────────
/*
 * The day chip: "Today · Thu 13 Aug", "اليوم · الخميس، 13 آب".
 *
 * weekday 'short' rather than 'long' for the width — this chip sits in a row of three and the
 * row has overflowed onto a third line before, when DEZ was added to the airport list. Arabic
 * ignores the distinction and returns الخميس either way, since it has no abbreviated weekday;
 * the shortening is a saving in English only, which is the script that needed it.
 */
function tabDateLabel(offset: number, locale: Locale): string {
  const d = syriaDate(offset)
  return new Date(d + 'T12:00:00Z').toLocaleDateString(dateLocaleOf(locale), {
    weekday: 'short', day: 'numeric', month: 'short',
  })
}

// ── Plane SVG ─────────────────────────────────────────────────────────────────

// ── Main page ─────────────────────────────────────────────────────────────────
export default function BoardPage() {
  const t      = useT()
  const href   = useHref()
  const locale = useLocale()
  const [tab, setTab]         = useState<Tab>(0)
  const [view, setView]       = useState<View>('arr')
  const [airport, setAirport] = useState<Airport>('DAM')
  const [flights, setFlights] = useState<Flight[]>([])
  const [loading, setLoading] = useState(true)
  const [date, setDate]       = useState('')
  const [query, setQuery]           = useState('')
  const [sortMode, setSortMode]     = useState<'time' | 'airline'>('time')
  const [airlineFilter, setAirlineFilter] = useState<string | null>(null)
  const [airlinePopover, setAirlinePopover] = useState(false)
  const [airportMenu, setAirportMenu]       = useState(false)
  const airlineBtnRef = useRef<HTMLButtonElement>(null)

  type WeeklyStats = {
    from: string; to: string; days: number
    arrivals: { iata: string; count: number }[]
    departures: { iata: string; count: number }[]
  }
  const [weeklyStats, setWeeklyStats] = useState<WeeklyStats | null>(null)

  const [pins, setPins] = useState<Set<string>>(() => {
    try {
      const stored = typeof window !== 'undefined' ? localStorage.getItem('flysyria_pins') : null
      return new Set(stored ? JSON.parse(stored) : [])
    } catch { return new Set() }
  })

  const togglePin = (num: string) => {
    setPins(prev => {
      const next = new Set(prev)
      next.has(num) ? next.delete(num) : next.add(num)
      try { localStorage.setItem('flysyria_pins', JSON.stringify([...next])) } catch {}
      return next
    })
  }

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
      // Don't gate on ver — always clear loading for non-silent calls.
      // setFlights is already guarded above; stale loads can still clear the spinner safely.
      if (!silent) setLoading(false)
    }
  }, [])

  const loadRef = useRef(load)
  useEffect(() => { loadRef.current = load }, [load])

  const warmFR24Cache = useCallback((airportCode: string, depth = 0) => {
    const TZ = 'Asia/Damascus'
    const flightDate = new Date().toLocaleDateString('en-CA', { timeZone: TZ })
    const ts = Math.floor(new Date(flightDate + 'T00:00:00+03:00').getTime() / 1000)
    const url = `https://api.flightradar24.com/common/v1/airport.json?code=${airportCode}&plugin=&plugin-setting[schedule][mode]=&plugin-setting[schedule][timestamp]=${ts}&page=1&limit=100&fleet=&token=`
    const fr24abort = new AbortController()
    const fr24timeout = setTimeout(() => fr24abort.abort(), 8_000)
    fetch(url, { signal: fr24abort.signal })
      .then(r => { clearTimeout(fr24timeout); return r.ok ? r.json() : null })
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
          const flight = { num, fr24_id: fl.identification?.id ?? null, airline: fl.airline?.name ?? null, airline_iata: fl.airline?.code?.iata ?? null, dep_iata: fl.airport?.origin?.code?.iata ?? null, arr_iata: fl.airport?.destination?.code?.iata ?? null, sched_dep: schedDep, sched_arr: schedArr, duration_min: Math.round((schedArr - schedDep) / 60), status: fl.status?.text ?? null, est_dep: fl.time?.estimated?.departure ?? null, est_arr: fl.time?.estimated?.arrival ?? null, real_dep: fl.time?.real?.departure ?? null, real_arr: fl.time?.real?.arrival ?? null, aircraft: fl.aircraft?.model?.code ?? null, reg, dep_terminal: fl.airport?.origin?.info?.terminal ?? null, dep_gate: fl.airport?.origin?.info?.gate ?? null, arr_terminal: fl.airport?.destination?.info?.terminal ?? null, arr_gate: fl.airport?.destination?.info?.gate ?? null, arr_baggage: fl.airport?.destination?.info?.baggage ?? null }
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
        /*
         * DISABLED 9 Aug 2026 — trial. Restore by uncommenting; nothing else changed.
         *
         * This fanned out to every non-Syrian origin in the arrivals list and fetched its
         * widget too — about 21 extra airports, ~25 requests to FR24 every five minutes from
         * every open tab, on an audience that is 72% mobile.
         *
         * What it bought, measured on 9 Aug:
         *   departure times   nothing. FR24's airport board carries both ends, so DAM's own
         *                     arrival row already holds the origin's real_dep — true for all
         *                     seven flights that had departed that morning.
         *   departure status  nothing, same reason.
         *   origin gate       20 of 42 rows filled, and never rendered: the arrivals view
         *                     draws arr_gate, and the departures view draws flights leaving
         *                     Damascus, whose gate comes from Damascus.
         *   busy origins      worse than nothing — DXB's cached day stopped at 03:55 and held
         *                     no Syria-bound departure at all, though XH728 leaves at 19:00.
         *
         * Left commented rather than deleted because one morning is one morning: if a carrier
         * turns up whose destination row lacks real_dep while its origin's board has it, this
         * is the thing to put back.
         *
         * if (depth === 0) {
         *   const origins = new Set<string>()
         *   for (const f of (sched.arrivals?.data ?? [])) {
         *     const dep = (f as any)?.flight?.airport?.origin?.code?.iata
         *     if (dep && dep !== airportCode) origins.add(dep as string)
         *   }
         *   origins.forEach(origin => warmFR24Cache(origin, 1))
         * }
         */
      })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * The live layer, on its own 30s clock.
   *
   * Separate from the board's 60s load because it answers a different question and changes at a
   * different rate: the board is a timetable, this is where the aircraft is now. 30s matches the
   * app, so a reader with both open does not see one lead the other.
   *
   * Keyed by both identifiers. A flight is filed under XH728 on the board and FYC728 in the feed,
   * and looking it up by one form only is the single most repeated bug in this codebase.
   */
  const [phases, setPhases] = useState<Record<string, string>>({})
  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const r = await fetch('/api/live')
        if (!r.ok) return
        const body = await r.json()
        if (!alive) return
        const next: Record<string, string> = {}
        for (const f of (body?.flights ?? []) as { iata_number?: string; callsign?: string; phase?: string }[]) {
          if (!f.phase) continue
          if (f.iata_number) next[f.iata_number.toUpperCase()] = f.phase
          if (f.callsign)    next[f.callsign.toUpperCase()]    = f.phase
        }
        setPhases(next)
      } catch { /* an absent phase is a normal state; the card keeps its status badge */ }
    }
    pull()
    const t = setInterval(pull, 30_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  useEffect(() => { loadGeoData() }, [])
  useEffect(() => { load(tab) }, [tab, load])
  useEffect(() => {
    if (tab !== 0) return
    /*
     * The board no longer warms the cache from the visitor's browser.
     *
     * Every reader that matters now comes from `flight`, filled by the harvester on a schedule
     * of our choosing. Warming from a browser is what made freshness track whoever happened to
     * open the site: on 10 Aug RJ434 left Aleppo at 10:06:45Z and did not reach the cache until
     * 10:17:51Z, the moment someone opened /fr24 on a desktop. It is also why the historical
     * rows froze around 21:00 each day and lost the late arrivals.
     *
     * warmFR24Cache is left in place, unused, until the remaining cache readers are migrated —
     * /api/flight, /api/weekly-stats, landing-confirm and three crons still read the table, and
     * cron/fr24-sync still fills it server-side.
     */
    const loadTimer = setInterval(() => load(0, true), 60_000)
    return () => { clearInterval(loadTimer) }
  }, [tab, load])

  // Read at fire time, not captured. The refresh below is armed when the airport changes and
  // only cancelled when it changes again — so changing day inside those four seconds used to
  // land a load() for the old day on the new day's board. On DAM that flashed today's flights
  // under a "tomorrow" heading; on DEZ, whose only flights are tomorrow, it emptied the board.
  const tabRef = useRef(tab)
  useEffect(() => { tabRef.current = tab }, [tab])

  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    // The four-second delay used to give the warm above time to land before reloading. Nothing
    // is being warmed now, but the delay stays: /api/flightboard is CDN-cached for 30s, so an
    // immediate reload would answer from the edge with the previous airport's board.
    const timer = setTimeout(() => load(tabRef.current, true), 4000)
    return () => clearTimeout(timer)
  }, [airport]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch(`/api/weekly-stats?airport=${airport}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.ok) setWeeklyStats(data) })
      .catch(() => {})
  }, [airport])

  const byViewAndAirport = (() => {
    if (view === 'dep') return flights.filter(f => f.dep_iata === airport)
    return flights.filter(f => f.arr_iata === airport)
  })()

  const sorted = [...byViewAndAirport]
    .filter(f => effectiveStatus(f) !== 'Unknown')
    .sort((a, b) => sortMode === 'airline'
      ? a.airline_name.localeCompare(b.airline_name) || effectiveLocalMin(a, view) - effectiveLocalMin(b, view)
      : effectiveLocalMin(a, view) - effectiveLocalMin(b, view))

  const airlineFiltered = airlineFilter ? sorted.filter(f => f.airline_iata === airlineFilter) : sorted

  /*
   * `name` is what the reader sees, so it is resolved before the sort rather than after.
   * Sorting the Arabic list by the English names leaves it in an order that is invisible on
   * screen — الاتحاد للطيران under E, طيران الجزيرة under J.
   */
  const availableAirlines = [...new Map(sorted.map(f => [
    f.airline_iata,
    { iata: f.airline_iata, name: airlineNameFor(f.airline_iata, f.airline_name), flag: f.country_flag },
  ])).values()]
    .sort((a, b) => a.name.localeCompare(b.name, locale === 'ar' ? 'ar' : 'en'))

  const nowSyriaMinRaw = Math.floor((Date.now() + 3 * 3_600_000) / 60_000) % 1440

  // Build pin-aware display order
  const pinnedSet   = pins
  const isPast      = (f: Flight) => effectiveStatus(f) === 'Arrived'
  const nonPinned   = airlineFiltered.filter(f => !pinnedSet.has(f.iata_number))
  const pinnedArr   = airlineFiltered.filter(f => pinnedSet.has(f.iata_number) && isPast(f))
  const pinnedFwd   = airlineFiltered.filter(f => pinnedSet.has(f.iata_number) && !isPast(f))
  const nonPinnedBefore = nonPinned.filter(f => effectiveLocalMin(f, view) < nowSyriaMinRaw)
  const nonPinnedAfter  = nonPinned.filter(f => effectiveLocalMin(f, view) >= nowSyriaMinRaw)
  const preDisplayed = [...nonPinnedBefore, ...pinnedArr, ...pinnedFwd, ...nonPinnedAfter]
  const nowDisplayIdx = tab === 0 ? nonPinnedBefore.length + pinnedArr.length : -1

  const nowLine = (complete: boolean) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '2px 0' }}>
      <div style={{ flex: 1, height: 1, background: C.separator }} />
      {(landed > 0 || complete) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px 5px 9px', borderRadius: 999, background: '#E6EFEC', border: '1px solid #B4CFC9' }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: C.forest, display: 'block' }} />
          <span style={{ font: `600 11.5px/1 'Instrument Sans', system-ui`, color: '#002623', whiteSpace: 'nowrap' }}>
            {landed} {t(view === 'arr' ? 'chip.arrived' : 'chip.departed')}
          </span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 999, background: C.ink }}>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, fontWeight: 600, color: '#fff', letterSpacing: '.04em' }}>
          {nowSyriaHHMM} {t('chip.now')}
        </span>
      </div>
      {(enroute > 0 || complete) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px 5px 9px', borderRadius: 999, background: C.forestMid }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: '#fff', display: 'block' }} />
          <span style={{ font: `600 11.5px/1 'Instrument Sans', system-ui`, color: '#fff', whiteSpace: 'nowrap' }}>
            {enroute} {t('chip.in_air')}
          </span>
        </div>
      )}
      <div style={{ flex: 1, height: 1, background: C.separator }} />
    </div>
  )

  const q = query.trim().toLowerCase()
  const displayed = q
    ? preDisplayed.filter(f =>
        f.iata_number.toLowerCase().includes(q) ||
        f.airline_name.toLowerCase().includes(q) ||
        f.airline_iata.toLowerCase().includes(q) ||
        city(f.dep_iata).toLowerCase().includes(q) ||
        city(f.arr_iata).toLowerCase().includes(q)
      )
    : preDisplayed

  const total     = sorted.length
  const landed    = sorted.filter(f => ['Arrived', 'Landed'].includes(effectiveStatus(f))).length
  const cancelled = sorted.filter(f => effectiveStatus(f) === 'Cancelled').length
  const enroute   = sorted.filter(f => ['En Route', 'Departed', 'Approaching'].includes(effectiveStatus(f))).length

  const firstEnRoute = sorted.find(f => ['En Route', 'Departed', 'Approaching'].includes(effectiveStatus(f))) ?? null

  const destFreq = (() => {
    const map: Record<string, { iata: string; flag: string; c: string; count: number }> = {}
    for (const f of sorted) {
      const iata = view === 'arr' ? f.dep_iata : f.arr_iata
      if (!iata || iata === airport) continue
      const c = city(iata)
      const flag = airportFlag(iata)
      if (!map[iata]) map[iata] = { iata, flag, c, count: 0 }
      map[iata].count++
    }
    return Object.values(map).sort((a, b) => b.count - a.count).slice(0, 8)
  })()
  const maxFreq = destFreq[0]?.count ?? 1

  const IATA_ALIAS: Record<string, string> = { SAW: 'IST' }
  const weeklyFreq = weeklyStats
    ? (() => {
        const src = view === 'arr' ? weeklyStats.arrivals : weeklyStats.departures
        const merged: Record<string, number> = {}
        for (const d of src) {
          const canonical = IATA_ALIAS[d.iata] ?? d.iata
          merged[canonical] = (merged[canonical] ?? 0) + d.count
        }
        return Object.entries(merged)
          .sort(([, a], [, b]) => b - a)
          .map(([iata, count]) => ({ iata, flag: airportFlag(iata), c: city(iata), count }))
      })()
    : null
  const weeklyMaxFreq = weeklyFreq?.[0]?.count ?? 1

  const nowSyriaHHMM = (() => {
    const d = new Date(Date.now() + 3 * 3_600_000)
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  })()

  const prevNowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!loading && nowDisplayIdx >= 1 && prevNowRef.current) {
      // Measured, not assumed. This used to be a flat 80px, which was about right when only
      // the header was sticky on desktop. The controls are sticky on phones now too, and
      // they wrap to two rows there, so 80px parked the card underneath them and clipped its
      // top — the airline and flight number, which is the part you are scanning for.
      const navH      = document.querySelector('.sn-bar')?.getBoundingClientRect().height ?? 58
      const controlsH = document.querySelector('.ft-controls-wrap')?.getBoundingClientRect().height ?? 0
      prevNowRef.current.style.scrollMarginTop = `${Math.round(navH + controlsH + 12)}px`
      prevNowRef.current.scrollIntoView({ behavior: 'instant', block: 'start' })
    }
  }, [loading, tab, view, airport])

  const dateLabel = date
    ? new Date(date + 'T12:00:00Z').toLocaleDateString(dateLocaleOf(locale), { weekday: 'long', day: 'numeric', month: 'long' })
    : ''

  const viewTitle    = t(view === 'arr' ? 'board.arrivals_for' : 'board.departures_for')
  const tabTitle     = t(tab === 0 ? 'day.today' : tab === -1 ? 'day.yesterday' : 'day.tomorrow')

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: "'Instrument Sans', system-ui, sans-serif" }}>
      <style>{`
        .ft-body { padding: 16px 16px 32px !important; flex-direction: column !important; }
        .ft-title { font-size: 26px !important; }
        .ft-content { flex-direction: column !important; }
        .ft-sidebar { display: none !important; }
        .ft-controls { gap: 8px !important; flex-wrap: wrap !important; }
        /* Sticky on phones as well as desktop. The board scrolls itself to the NOW line on
           load, which already leaves these controls above the fold — without this, changing
           day or direction means scrolling back up first. 58px is the mobile header height;
           the desktop rule below overrides it with 68px. */
        .ft-controls-wrap { position: sticky; top: 58px; z-index: 10; background: #EDEBE0; padding: 10px 0; margin: -10px 0; }
        .ft-airport-btn { padding: 8px 14px !important; }
        .ft-airport-pills { display: none !important; }
        /*
          Fill the width instead of packing to the start. The Arabic labels are shorter than
          the English ones, so the same controls left a ragged gap down one side — and the
          spacer below was taking the leftover rather than the buttons.
        */
        .ft-day-tabs { flex: 1 1 100%; }
        /*
          Grow from the content, not to equal thirds. Equal widths ignore what is in them, and
          the middle tab carries a date — "9 Aug" wrapped onto a second line while Yesterday
          and Tomorrow sat in space they did not need.
        */
        .ft-day-tabs > button { flex: 1 1 auto; justify-content: center; white-space: nowrap; }
        .ft-view-toggle { flex: 1; }
        .ft-view-toggle > button { flex: 1 1 auto; justify-content: center; white-space: nowrap; }
        .ft-spacer { display: none !important; }
        .ft-airport-menu  { display: block; }
        .ft-sort-btns { display: none !important; }
        /* Aircraft type is desktop-only — see the MetaStrip call site for why. */
        .ft-ac-type { display: none; }
        @media (min-width: 768px) {
          .ft-ac-type { display: inline; }
          .ft-body { padding: 26px 28px 40px !important; }
          .ft-title { font-size: 34px !important; }
          .ft-content { flex-direction: row !important; align-items: flex-start !important; }
          .ft-sidebar { display: flex !important; flex-direction: column; gap: 16px; width: 320px; flex-shrink: 0; position: sticky !important; top: 78px !important; align-self: flex-start !important; max-height: calc(100vh - 90px); overflow-y: auto; }
          /*
            The controls live inside the list column, not above the whole page, so they take
            its width without being told to — and the sidebar starts level with them instead
            of below, which left a blank rectangle above the live-map box.
          */
          .ft-controls-wrap { position: sticky; top: 68px; z-index: 10; background: #EDEBE0; padding: 10px 0; margin: -10px 0; }
          .ft-controls { gap: 12px !important; }
          .ft-airport-btn { padding: 8px 32px !important; }
          .ft-airport-pills { display: flex !important; }
          .ft-airport-menu  { display: none; }
          .ft-sort-btns { display: flex !important; }
        }
        @media (min-width: 1100px) {
          .ft-body { padding: 26px 40px 40px !important; }
          /*
            Dead rule, kept as it was found: .ft-sidebar carries an inline width:320, which
            beats a stylesheet declaration, so the sidebar is 320 at every desktop width. The
            controls' margin above stays 340 for that reason — matching this 352 would overhang
            the list by 32px, which is exactly what it did on the first attempt.
          */
          .ft-sidebar { width: 352px; }
        }
      `}</style>

      {/* ── Nav bar ── */}
      <SiteNav active="Flights" right={
        <div style={{
          display: 'flex', width: 260, height: 38, borderRadius: 10, background: C.sunken,
          border: `1px solid ${query ? C.forest : C.border}`, alignItems: 'center', gap: 9, padding: '0 12px',
        }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.9" strokeLinecap="round">
            <circle cx="11" cy="11" r="7"/><path d="m20 20-4.3-4.3"/>
          </svg>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('nav.search')}
            style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', font: `500 12.5px/1 'Instrument Sans', system-ui`, color: C.ink, minWidth: 0 }}
          />
          {query
            ? <button onClick={() => setQuery('')} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: C.muted, fontSize: 14, lineHeight: 1 }}>✕</button>
            : <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, color: '#A6A093', background: C.bg, padding: '3px 5px', borderRadius: 4, flexShrink: 0 }}>⌘K</span>
          }
        </div>
      } />

      {/* ── Main body ── */}
      <div className="ft-body" style={{ maxWidth: 1400, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Title + controls */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <h1 className="ft-title" style={{ margin: 0, font: `700 34px/1 'Instrument Sans', system-ui`, color: C.ink, letterSpacing: '-.025em' }}>
              {viewTitle} {tabTitle}
            </h1>
          </div>

          {/* Controls row */}

          {/* ── Content: cards + sidebar ── */}
          <div className="ft-content" style={{ display: 'flex', gap: 20 }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="ft-controls-wrap">
          <div className="ft-controls" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Date tabs */}
            <div className="ft-day-tabs" style={{ display: 'flex', gap: 6 }}>
              {/* `tb`, not `t` — the loop variable used to be `t` and now shadows the translator. */}
              {([-1, 0, 1] as Tab[]).map(tb => (
                <button key={tb} onClick={() => setTab(tb)} style={{
                  padding: '9px 14px 10px', borderRadius: 12, cursor: 'pointer',
                  background: tab === tb ? C.ink : C.surface,
                  border: tab === tb ? 'none' : `1px solid ${C.border}`,
                  display: 'flex', alignItems: 'baseline', gap: 7,
                  boxShadow: tab === tb ? '0 8px 18px -10px rgba(22,22,22,.55)' : 'none',
                }}>
                  <span style={{ font: `${tab === tb ? 700 : 600} 13px/1 'Instrument Sans', system-ui`, color: tab === tb ? '#fff' : C.secondary }}>
                    {tb === -1 ? t('day.yesterday')
                      : tb === 0 ? `${t('label.today_prefix')} · ${tabDateLabel(0, locale)}`
                      : t('day.tomorrow')}
                  </span>
                  {tab === tb && total > 0 && (
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, fontWeight: 600, background: '#B9A779', color: C.ink, padding: '3px 5px', borderRadius: 5 }}>
                      {total}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Arr / Dep + DAM / ALP */}
            <div className="ft-view-toggle" style={{ display: 'flex', padding: 3, background: C.border, borderRadius: 11, gap: 3 }}>
              {(['arr', 'dep'] as View[]).map(v => (
                <button key={v} onClick={() => setView(v)} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 9, cursor: 'pointer',
                  background: view === v ? C.surface : 'transparent',
                  border: 'none',
                  boxShadow: view === v ? '0 1px 3px rgba(22,22,22,.14)' : 'none',
                }}>
                  <span style={{ font: `600 13px/1 'Instrument Sans', system-ui`, color: view === v ? C.ink : C.muted }}>
                    {t(v === 'arr' ? 'view.arrivals' : 'view.departures')}
                  </span>
                  {view === v && (
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, fontWeight: 600, color: C.forest, background: '#E6EFEC', padding: '2px 5px', borderRadius: 5 }}>
                      {total}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/*
              Pills on desktop, a dropdown on the phone.

              Three pills measured 205px against a 343px row, and with the arrivals/departures
              toggle at 166 the pair no longer fitted — the airport row dropped to a third
              line and the sticky block grew from 87px to 134 on an 812px screen. Squeezing
              the pills only bought 8px of headroom and would break again on اللاذقية or
              القامشلي; a dropdown is one control at any airport count.
            */}
            <div className="ft-airport-pills" style={{ display: 'flex', padding: 3, background: C.border, borderRadius: 11, gap: 3 }}>
              {AIRPORTS.map(ap => (
                <button key={ap} onClick={() => setAirport(ap)} className="ft-airport-btn" style={{
                  padding: '8px 32px', borderRadius: 9, cursor: 'pointer',
                  background: airport === ap ? C.forest : 'transparent',
                  border: 'none',
                  /* The code is a code — mono and letter-spaced suits DAM and not دمشق, which
                     wants the display face and no tracking. */
                  fontFamily: locale === 'ar' ? "'Instrument Sans', system-ui" : "'IBM Plex Mono', monospace",
                  fontSize: 14, fontWeight: 700,
                  color: airport === ap ? '#fff' : C.muted,
                  letterSpacing: locale === 'ar' ? 'normal' : '.07em',
                  whiteSpace: 'nowrap',
                }}>
                  {locale === 'ar' ? cityFor(ap) : ap}
                </button>
              ))}
            </div>

            <div className="ft-airport-menu" style={{ position: 'relative' }}>
              <button
                onClick={() => setAirportMenu(v => !v)}
                aria-haspopup="listbox"
                aria-expanded={airportMenu}
                style={{
                  // 40px, not the padding's natural 29 — it sits beside the arrivals toggle,
                  // and two controls on one line that disagree by 11px read as a mistake.
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  height: 40, padding: '0 14px', borderRadius: 11,
                  cursor: 'pointer', background: C.forest, border: 'none', whiteSpace: 'nowrap',
                }}
              >
                <span style={{ font: `700 13px/1 'Instrument Sans', system-ui`, color: '#fff' }}>
                  {locale === 'ar' ? cityFor(airport) : airport}
                </span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.75)"
                     strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                     style={{ transform: airportMenu ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
                  <path d="m6 9 6 6 6-6"/>
                </svg>
              </button>

              {airportMenu && (
                <>
                  <div onClick={() => setAirportMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 99 }} />
                  <div role="listbox" style={{
                    position: 'absolute', top: 'calc(100% + 6px)', insetInlineStart: 0, zIndex: 100,
                    background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
                    boxShadow: '0 8px 24px -8px rgba(22,22,22,.22)', minWidth: 150, padding: '6px 0',
                  }}>
                    {AIRPORTS.map(ap => (
                      <button key={ap} role="option" aria-selected={airport === ap}
                        onClick={() => { setAirport(ap); setAirportMenu(false) }}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                          width: '100%', padding: '10px 14px', border: 'none', cursor: 'pointer',
                          background: airport === ap ? C.sunken : 'transparent', textAlign: 'start',
                        }}>
                        <span style={{ font: `${airport === ap ? 700 : 500} 13.5px/1 'Instrument Sans', system-ui`, color: C.ink }}>
                          {cityFor(ap)}
                        </span>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: C.muted, letterSpacing: '.06em' }}>
                          {ap}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="ft-spacer" style={{ flex: 1 }} />

            {/* Airline filter + Sort — desktop only */}
            <div className="ft-sort-btns" style={{ gap: 8, alignItems: 'center', position: 'relative' }}>
              {/* Airline filter button */}
              <button ref={airlineBtnRef} onClick={() => setAirlinePopover(p => !p)} style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 10, cursor: 'pointer',
                background: airlineFilter ? C.forest : C.surface,
                border: `1px solid ${airlineFilter ? C.forest : C.border}`,
                boxShadow: '0 1px 2px rgba(22,22,22,.06)',
              }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <line x1="2" y1="4" x2="14" y2="4" stroke={airlineFilter ? '#fff' : C.secondary} strokeWidth="1.5" strokeLinecap="round"/>
                  <line x1="4" y1="8" x2="12" y2="8" stroke={airlineFilter ? '#fff' : C.secondary} strokeWidth="1.5" strokeLinecap="round"/>
                  <line x1="6" y1="12" x2="10" y2="12" stroke={airlineFilter ? '#fff' : C.secondary} strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                <span style={{ font: `600 13px/1 'Instrument Sans', system-ui`, color: airlineFilter ? '#fff' : C.secondary }}>
                  {airlineFilter
                    ? (availableAirlines.find(a => a.iata === airlineFilter)?.name ?? airlineFilter)
                    : t('filter.airline')}
                </span>
                {airlineFilter && (
                  <span onClick={e => { e.stopPropagation(); setAirlineFilter(null); setAirlinePopover(false) }}
                    style={{ color: 'rgba(255,255,255,.7)', fontSize: 13, lineHeight: 1, cursor: 'pointer' }}>✕</span>
                )}
              </button>

              {/* Airline popover */}
              {airlinePopover && (
                <>
                  <div onClick={() => setAirlinePopover(false)} style={{ position: 'fixed', inset: 0, zIndex: 99 }} />
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 100,
                    background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
                    boxShadow: '0 8px 24px -8px rgba(22,22,22,.22)', minWidth: 200, maxHeight: 320, overflowY: 'auto',
                    padding: '6px 0',
                  }}>
                    {availableAirlines.map(a => (
                      <button key={a.iata} onClick={() => { setAirlineFilter(airlineFilter === a.iata ? null : a.iata); setAirlinePopover(false) }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '9px 14px',
                          background: airlineFilter === a.iata ? C.sunken : 'transparent', border: 'none', cursor: 'pointer', textAlign: 'start',
                        }}>
                        <span style={{ fontSize: 15 }}>{a.flag}</span>
                        <span style={{ font: `${airlineFilter === a.iata ? 700 : 500} 12.5px/1 'Instrument Sans', system-ui`, color: airlineFilter === a.iata ? C.forest : C.ink }}>
                          {a.name}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* Sort toggle */}
              <button onClick={() => setSortMode(m => m === 'time' ? 'airline' : 'time')} style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 10, cursor: 'pointer',
                background: sortMode === 'airline' ? C.sunken : C.surface,
                border: `1px solid ${sortMode === 'airline' ? C.forest : C.border}`,
                lineHeight: '14px',
              }}>
                <span style={{ font: `600 12.5px/14px 'Instrument Sans', system-ui`, color: sortMode === 'airline' ? C.forest : C.secondary }}>
                  {t('sort.by')} · {t(sortMode === 'time' ? 'sort.scheduled' : 'sort.airline_az')}
                </span>
              </button>
            </div>
          </div>
          </div>{/* end ft-controls-wrap */}

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
              <p style={{ color: C.secondary, fontWeight: 600, margin: 0 }}>{t(view === 'arr' ? 'board.no_arrivals' : 'board.no_departures')}</p>
              <p style={{ color: C.muted, fontSize: 14, margin: 0 }}>{airport} · {dateLabel}</p>
            </div>
          )}

          {/* The now marker, rendered either between two cards or after the last one.
              `complete` is the end-of-day case: every flight is behind us, so the marker has
              no card to precede and used to vanish entirely — the board then looked identical
              to one that had never loaded live data. There it also forces both counts to show,
              including a zero, because "N arrived · 0 in air" is exactly the signal that the
              day is finished. Mid-list a zero count is just noise, so it stays hidden. */}
          {/* Flight cards */}
          {!loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {displayed.map((f, i) => (
                <Fragment key={`${f.iata_number}-${f.dep_iata}-${f.arr_iata}-${f.dep_time_utc}-${f.arr_time_utc}`}>
                  {i === nowDisplayIdx && nowLine(false)}
                  <div ref={i === nowDisplayIdx - 1 ? prevNowRef : undefined}>
                    <FlightCard f={f} view={view} isPinned={pins.has(f.iata_number)} onTogglePin={() => togglePin(f.iata_number)} boardDate={tab === 0 ? undefined : date} phase={phases[f.iata_number?.toUpperCase()] ?? (f.callsign ? phases[f.callsign.toUpperCase()] : undefined)} />
                  </div>
                </Fragment>
              ))}
              {tab === 0 && !q && displayed.length > 0 && nowDisplayIdx >= displayed.length && nowLine(true)}
            </div>
          )}

          {tab === 1 && !loading && sorted.length > 0 && (
            <p style={{ textAlign: 'center', color: C.muted, fontSize: 12, marginTop: 24 }}>
              {t('board.tomorrow_note')}
            </p>
          )}
            </div>{/* end cards column */}

            {/* ── Sidebar (desktop only) ── */}
            <div className="ft-sidebar" style={{ width: 320, flexShrink: 0 }}>

          {/* Live map card */}
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, overflow: 'hidden', boxShadow: '0 1px 2px rgba(22,22,22,.05)' }}>
            <div style={{ position: 'relative', height: 236, background: C.bg, overflow: 'hidden' }}>
              {/* Grid */}
              <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(22,22,22,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(22,22,22,.05) 1px,transparent 1px)', backgroundSize: '52px 52px' }} />
              {/* Land blobs */}
              <div style={{ position: 'absolute', left: -30, top: 24, width: 200, height: 140, background: '#D3DAD6', borderRadius: '48% 52% 60% 40%/55% 45% 55% 45%' }} />
              <div style={{ position: 'absolute', right: -50, bottom: -40, width: 230, height: 200, background: '#D3DAD6', borderRadius: '52% 48% 40% 60%/45% 55% 45% 55%', opacity: 0.8 }} />
              {/* Flight arc */}
              <svg viewBox="0 0 352 236" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} fill="none">
                <path d="M280 190 C240 160 180 130 122 112" stroke={C.forestMid} strokeWidth="2" strokeDasharray="1 6" strokeLinecap="round" opacity=".6"/>
              </svg>
              {/* DAM pin */}
              <div style={{ position: 'absolute', left: 112, top: 104, width: 12, height: 12, borderRadius: 99, background: C.forest, border: '3px solid #fff', boxShadow: '0 2px 6px rgba(22,22,22,.3)' }} />
              <div style={{ position: 'absolute', left: 84, top: 122, fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, fontWeight: 600, lineHeight: 1, color: C.forest, background: 'rgba(255,255,255,.92)', padding: '3px 5px', borderRadius: 4 }}>DAM</div>
              {/* ALP pin */}
              <div style={{ position: 'absolute', left: 158, top: 66, width: 9, height: 9, borderRadius: 99, background: C.wine, border: '2.5px solid #fff' }} />
              <div style={{ position: 'absolute', left: 172, top: 62, fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, fontWeight: 600, lineHeight: 1, color: C.wine, background: 'rgba(255,255,255,.92)', padding: '3px 5px', borderRadius: 4 }}>ALP</div>
              {/* Aircraft marker */}
              <div style={{ position: 'absolute', left: 246, top: 162, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <span style={{ fontSize: 19, transform: 'rotate(-30deg)', filter: 'drop-shadow(0 2px 3px rgba(22,22,22,.3))', display: 'block' }}>✈️</span>
                {firstEnRoute && (
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, fontWeight: 700, lineHeight: 1, color: '#fff', background: C.forestMid, padding: '3px 5px', borderRadius: 4 }}>
                    {firstEnRoute.iata_number}
                  </span>
                )}
              </div>
              {/* In-air chip */}
              <div style={{ position: 'absolute', left: 14, top: 14, display: 'flex', alignItems: 'center', gap: 7, padding: '7px 11px', borderRadius: 9, background: 'rgba(255,255,255,.94)', border: `1px solid ${C.border}`, boxShadow: '0 4px 12px -8px rgba(22,22,22,.4)' }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: C.forestMid, display: 'block' }} />
                <span style={{ font: `600 11px/1 'Instrument Sans', system-ui`, color: C.ink }}>{enroute} {t('map.in_air')}</span>
              </div>
            </div>
            <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: `1px solid ${C.trackEmpty}` }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ font: `600 13.5px/1 'Instrument Sans', system-ui`, color: C.ink }}>{t('map.live')}</span>
                <span style={{ font: `500 11px/1 'Instrument Sans', system-ui`, color: C.muted }}>{t('map.tiles')}</span>
              </div>
              <Link href={href('/map')} style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 9,
                background: C.forest, textDecoration: 'none',
              }}>
                <span style={{ font: `600 12px/1 'Instrument Sans', system-ui`, color: '#fff' }}>{t('action.open_track')}</span>
              </Link>
            </div>
          </div>

          {/* Top origins/destinations — 7-day frequency, split by region */}
          {(() => {
            const freq = weeklyFreq ?? destFreq
            if (!freq.length) return null
            const periodLabel = t(weeklyStats ? 'period.last_7_days' : 'period.today')

            const groups: Record<string, typeof freq> = {}
            for (const d of freq) {
              const r = REGION[d.iata] ?? 'Other'
              if (!groups[r]) groups[r] = []
              groups[r].push(d)
            }

            return REGION_ORDER.filter(r => groups[r]?.length).map(region => {
              const items = groups[region]
              const regionMax = items[0].count
              return (
                <div key={region} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 1px 2px rgba(22,22,22,.05)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    {/* The region name is the grouping key as well as the label, so it is
                        translated at the point of display rather than in REGION_ORDER. */}
                    <span style={{ font: `600 13.5px/1 'Instrument Sans', system-ui`, color: C.ink }}>{t(REGION_KEY[region] ?? '')  || region}</span>
                    <span style={{ font: `500 11px/1 'Instrument Sans', system-ui`, color: C.muted }}>{periodLabel}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {items.map(d => (
                      <div key={d.iata} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 14 }}>{d.flag}</span>
                        <span style={{ font: `600 12.5px/1 'Instrument Sans', system-ui`, color: C.ink, width: 84, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.c}</span>
                        <div style={{ flex: 1, height: 6, borderRadius: 99, background: C.trackEmpty, position: 'relative' }}>
                          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.round((d.count / regionMax) * 100)}%`, background: d.count === regionMax ? C.forest : C.forestMid, borderRadius: 99 }} />
                        </div>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600, color: C.secondary, width: 20, textAlign: 'right' }}>{d.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })
          })()}

          {/* CTA card */}
          <div style={{ background: C.forest, borderRadius: 16, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={{ font: `700 15px/1.25 'Instrument Sans', system-ui`, color: '#EDEBE0', letterSpacing: '-.01em' }}>
              {t('cta.follow_title')}
            </span>
            <span style={{ font: `400 12px/1.5 'Instrument Sans', system-ui`, color: 'rgba(237,235,224,.72)' }}>
              {t('cta.follow_body')}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, padding: '10px 12px', borderRadius: 9, background: '#EDEBE0', textAlign: 'center', font: `600 12px/1 'Instrument Sans', system-ui`, color: C.forest }}>
                {t('store.app_store')}
              </div>
              <div style={{ flex: 1, padding: '10px 12px', borderRadius: 9, background: 'rgba(237,235,224,.15)', textAlign: 'center', font: `600 12px/1 'Instrument Sans', system-ui`, color: '#EDEBE0' }}>
                {t('store.google_play')}
              </div>
            </div>
          </div>
            </div>{/* end ft-sidebar */}
          </div>{/* end ft-content */}

          {/* Footer */}
          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 18, display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
            <span style={{ font: `500 11.5px/1 'Instrument Sans', system-ui`, color: C.muted }}>© 2026 FlySyria</span>
            <span style={{ font: `500 11.5px/1 'Instrument Sans', system-ui`, color: C.muted }}>Damascus · Aleppo</span>
            <span style={{ font: `500 11.5px/1 'Instrument Sans', system-ui`, color: C.muted }}>{t('board.updated')}</span>
            <div style={{ flex: 1 }} />
            <LanguageSwitch />
          </div>
      </div>{/* end ft-body */}
    </div>
  )
}

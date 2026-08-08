'use client'
import { usePhotoUploadVisible } from '@/lib/ui-flags'

import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { AIRLINE_LOGOS, LOGO_WHITE_BG } from '@/lib/airlines'
import { cityFor, airlineNameFor, getActiveLocale, airportFlag as _apFlag, loadGeoData } from '@/lib/geo-data'
import { useT, useLocale } from '@/components/LocaleProvider'
import SiteNav from '@/components/SiteNav'
import LanguageSwitch from '@/components/LanguageSwitch'
import { BOARD_AIRPORTS, type BoardAirport } from '@/lib/syria-airports'

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  bg:        '#EDEBE0',
  surface:   '#FFFFFF',
  border:    '#D8D3BF',
  ink:       '#161616',
  muted:     '#8A8578',
  secondary: '#3D3A3B',
  forest:    '#054239',
  forestMid: '#428177',
  gold:      '#988561',
  sunken:    '#F7F5EC',
  separator: '#E0DCCB',
}

const city = (iata: string) => cityFor(iata)
const apFlag = (iata: string) => _apFlag[iata] ?? ''

// Override display names where multiple airports share a city name
const DEST_NAME: Record<string, string> = {
  IST: 'Istanbul Airport',
  SAW: 'Istanbul Sabiha',
}
const DEST_NAME_AR: Record<string, string> = {
  IST: 'مطار إسطنبول',
  SAW: 'صبيحة إسطنبول',
}
/*
 * Reads the locale from the module rather than a hook: this is called from memos and sort
 * comparators as well as from components, and threading a parameter through all of them for
 * two airports would be worse than the one global the provider already sets during render.
 */
const destName = (iata: string) =>
  (getActiveLocale() === 'ar' ? DEST_NAME_AR[iata] : DEST_NAME[iata]) ?? city(iata)

/** Lowercased and stripped of accents, so "dusseldorf" finds Düsseldorf. */
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

// ── Region classification ─────────────────────────────────────────────────────
type RegionId = 'all' | 'gulf' | 'europe'
const REGION_MAP: Record<string, RegionId> = {
  DXB: 'gulf', DWC: 'gulf', SHJ: 'gulf', AUH: 'gulf', DOH: 'gulf',
  KWI: 'gulf', MCT: 'gulf', RUH: 'gulf', JED: 'gulf', DMM: 'gulf', MED: 'gulf',
  AMM: 'gulf', BEY: 'gulf', BGW: 'gulf', EBL: 'gulf', NJF: 'gulf', BSR: 'gulf',
  CAI: 'gulf', SSH: 'gulf',
  IST: 'europe', SAW: 'europe', ESB: 'europe', ADB: 'europe', AYT: 'europe',
  ATH: 'europe', OTP: 'europe', VIE: 'europe', FRA: 'europe', CDG: 'europe',
  LHR: 'europe', AMS: 'europe', MXP: 'europe', FCO: 'europe', WAW: 'europe',
  BER: 'europe', MUC: 'europe', BCN: 'europe', MAD: 'europe', ZRH: 'europe',
  GYD: 'europe', TBS: 'europe', EVN: 'europe', DUS: 'europe',
  SVO: 'europe', THR: 'europe', IKA: 'europe',
  MJI: 'gulf',
}
const REGION_FILTERS: { id: RegionId; label: string; short: string }[] = [
  { id: 'all',    label: 'region.all_full',      short: 'region.all' },
  { id: 'gulf',   label: 'region.gulf',          short: 'region.med' },
  { id: 'europe', label: 'region.europe_turkey', short: 'region.europe' },
]
const REGION_SECTIONS: { id: RegionId; label: string }[] = [
  { id: 'gulf',   label: 'region.gulf' },
  { id: 'europe', label: 'region.europe_turkey' },
]

// ── Destination photo gradients ───────────────────────────────────────────────
const DEST_BG: Record<string, string> = {
  DXB: 'linear-gradient(140deg,#C8A06A 0%,#7A5020 100%)',
  SHJ: 'linear-gradient(140deg,#C4A560 0%,#8B6518 100%)',
  AUH: 'linear-gradient(140deg,#BCA070 0%,#705428 100%)',
  DOH: 'linear-gradient(140deg,#C0AA80 0%,#786430 100%)',
  KWI: 'linear-gradient(140deg,#CCAA78 0%,#8A6830 100%)',
  AMM: 'linear-gradient(140deg,#C8B0A0 0%,#806050 100%)',
  BEY: 'linear-gradient(140deg,#8AAAC0 0%,#486882 100%)',
  BGW: 'linear-gradient(140deg,#C8A870 0%,#806030 100%)',
  EBL: 'linear-gradient(140deg,#C0A870 0%,#786228 100%)',
  NJF: 'linear-gradient(140deg,#C4B090 0%,#826848 100%)',
  BSR: 'linear-gradient(140deg,#C8AA78 0%,#806038 100%)',
  CAI: 'linear-gradient(140deg,#D0B880 0%,#907840 100%)',
  IST: 'linear-gradient(140deg,#7A8CAA 0%,#3A4E6A 100%)',
  SAW: 'linear-gradient(140deg,#7A90A8 0%,#3A5068 100%)',
  ATH: 'linear-gradient(140deg,#9A9888 0%,#5A5848 100%)',
  BER: 'linear-gradient(140deg,#7A8898 0%,#3A4858 100%)',
  AMS: 'linear-gradient(140deg,#688098 0%,#304858 100%)',
  FRA: 'linear-gradient(140deg,#8A7A98 0%,#4A3A58 100%)',
  VIE: 'linear-gradient(140deg,#88909A 0%,#485058 100%)',
  OTP: 'linear-gradient(140deg,#809098 0%,#405058 100%)',
  WAW: 'linear-gradient(140deg,#8090A0 0%,#405060 100%)',
  CDG: 'linear-gradient(140deg,#8888A0 0%,#484860 100%)',
  LHR: 'linear-gradient(140deg,#7888A0 0%,#384860 100%)',
  GYD: 'linear-gradient(140deg,#689880 0%,#285840 100%)',
  TBS: 'linear-gradient(140deg,#809878 0%,#405838 100%)',
  EVN: 'linear-gradient(140deg,#A08878 0%,#604838 100%)',
  SVO: 'linear-gradient(140deg,#909898 0%,#505858 100%)',
}
const destBg = (iata: string) => DEST_BG[iata] ?? 'linear-gradient(140deg,#A8A090 0%,#686050 100%)'

const DOW_ORDER = ['sun','mon','tue','wed','thu','fri','sat'] as const
const dowLabel = (d: string, t: (k: string) => string) => t(`dow.${d}`)

// Arabic carries no English unit letters — see the twin in FlightDetail.
function fmtDur(min: number) {
  if (!min) return ''
  const h = Math.floor(min / 60), m = min % 60
  if (getActiveLocale() === 'ar') return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m} د`
  return m ? `${h}h ${m}m` : `${h}h`
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface ScheduleRow {
  dep_iata: string; arr_iata: string; dep_time: string; arr_time: string
  duration_min: number; days_of_week: string[]; iata_number: string
  airline_iata: string; airline_name: string; country_flag: string
}
interface AirlineChip { prefix: string; name: string; flag: string }
interface Destination {
  iata: string; region: RegionId; airlines: AirlineChip[]
  flights: ScheduleRow[]; reverseFlights: ScheduleRow[]
  minDuration: number; weeklyCount: number
}

// ── Airline logo ──────────────────────────────────────────────────────────────
function AirlineLogo({ prefix, name, size = 22 }: { prefix: string; name: string; size?: number }) {
  const [src, setSrc] = useState(AIRLINE_LOGOS[prefix] ?? `https://images.flightsfrom.com/airlines/100/${prefix}_100px.png`)
  const [failed, setFailed] = useState(false)
  if (failed) return <span style={{ fontSize: 13, lineHeight: 1 }} title={name}>✈</span>
  return (
    <img src={src} alt={name} title={name} width={size} height={size}
      style={{ borderRadius: 5, objectFit: 'cover', background: LOGO_WHITE_BG.has(prefix) ? '#fff' : undefined }}
      onError={() => { if (AIRLINE_LOGOS[prefix] && src === AIRLINE_LOGOS[prefix]) setSrc(`https://images.flightsfrom.com/airlines/100/${prefix}_100px.png`); else setFailed(true) }}
    />
  )
}

// ── Nav bar ───────────────────────────────────────────────────────────────────


// ── Airport hero image ────────────────────────────────────────────────────────
// The name comes from cityFor at render time, so it follows the language; only the artwork
// belongs here.
const AIRPORT_HERO: Record<string, { src: string; fallback: string }> = {
  DAM: { src: '/dam-hero.jpg', fallback: 'linear-gradient(135deg,#2E4A3E 0%,#1A2E28 100%)' },
  ALP: { src: '/alp-hero.jpg', fallback: 'linear-gradient(135deg,#4A3828 0%,#2C2018 100%)' },
  // No photo yet — the img's onError drops to the gradient, so this reads correctly
  // until one is added. Without an entry it would fall through to Damascus's hero.
  DEZ: { src: '/dez-hero.jpg', fallback: 'linear-gradient(135deg,#3A4436 0%,#1F261C 100%)' },
}

function AirportHero({ airport, totalDests, totalFlights }: { airport: string; totalDests: number; totalFlights: number }) {
  const t   = useT()
  const cfg = AIRPORT_HERO[airport] ?? AIRPORT_HERO.DAM
  const label = city(airport)
  const [imgFailed, setImgFailed] = useState(false)
  useEffect(() => { setImgFailed(false) }, [airport])

  const effectiveSrc = !imgFailed ? cfg.src : null

  return (
    <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', background: cfg.fallback, height: '100%' }}>
      {effectiveSrc && (
        <img
          key={effectiveSrc}
          src={effectiveSrc}
          alt={label}
          onError={() => setImgFailed(true)}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' }}
        />
      )}
      {/* Dark gradient overlay */}
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,.55) 0%, rgba(0,0,0,.1) 50%, transparent 100%)' }} />
      {/* Bottom label */}
      <div style={{ position: 'absolute', insetInlineStart: 18, bottom: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ font: `700 22px/1 'Instrument Sans',system-ui`, color: '#fff', letterSpacing: '-.02em', textShadow: '0 1px 8px rgba(0,0,0,.4)' }}>{label}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {totalDests > 0 && <span style={{ font: `600 12px/1 'Instrument Sans',system-ui`, color: 'rgba(255,255,255,.85)' }}>{totalDests} {t('dest.count')}</span>}
          {totalFlights > 0 && <span style={{ font: `600 12px/1 'Instrument Sans',system-ui`, color: 'rgba(255,255,255,.6)' }}>· {totalFlights} {t('airlines.per_week')}</span>}
        </div>
      </div>
      {/* IATA badge, on the far side from the name */}
      <div style={{ position: 'absolute', insetInlineEnd: 14, top: 14 }}>
        <div style={{ padding: '5px 10px', borderRadius: 8, background: 'rgba(0,0,0,.35)', backdropFilter: 'blur(6px)' }}>
          <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, fontWeight: 700, color: '#fff', letterSpacing: '.08em' }}>{airport}</span>
        </div>
      </div>
    </div>
  )
}

// ── Destination card — desktop ────────────────────────────────────────────────
function DestCardDesktop({ dest, onView, weeklyCount, imageUrl, onImageUploaded }: {
  dest: Destination; onView: () => void; weeklyCount: number; imageUrl?: string
  onImageUploaded: (iata: string, url: string) => void
}) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const photoUploadVisible = usePhotoUploadVisible()
  const bg = destBg(dest.iata)
  const badge = weeklyCount >= 14 ? C.forest : C.gold
  const [imgFailed, setImgFailed] = useState(false)
  useEffect(() => { setImgFailed(false) }, [imageUrl])
  const showImg = imageUrl && !imgFailed

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const form = new FormData()
    form.append('iata', dest.iata)
    form.append('file', file)
    const res = await fetch('/api/dest-images', { method: 'POST', body: form })
    const data = await res.json()
    if (data.ok) onImageUploaded(dest.iata, data.url)
    setUploading(false)
    e.target.value = ''
  }
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, overflow: 'hidden', boxShadow: `0 1px 2px rgba(22,22,22,.05),0 12px 26px -22px rgba(22,22,22,.5)`, display: 'flex', flexDirection: 'column' }}>
      {/* Photo area */}
      <div style={{ position: 'relative', height: 160, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {showImg
          ? <img src={imageUrl} alt={destName(dest.iata)} onError={() => setImgFailed(true)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span style={{ fontSize: 40, opacity: .35 }}>{apFlag(dest.iata)}</span>
        }
        {showImg && <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,.35) 0%, transparent 55%)' }} />}
        {photoUploadVisible && (<>
        <button onClick={() => fileRef.current?.click()} disabled={uploading}
          style={{ position: 'absolute', insetInlineEnd: 10, bottom: 10, display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, background: 'rgba(0,0,0,.38)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.18)', cursor: 'pointer', color: '#fff', font: `600 11px/1 'Instrument Sans',system-ui`, opacity: uploading ? .6 : 1 }}>
          {uploading ? 'Uploading…' : 'Photo'}
        </button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFile} />
        </>)}
      </div>
      {/* Info */}
      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 9, flex: 1 }}>
        {/* Row 1: Flag + City | Duration */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 20 }}>{apFlag(dest.iata)}</span>
            <span style={{ font: `700 16px/1.1 'Instrument Sans',system-ui`, color: C.ink, letterSpacing: '-.01em' }}>{destName(dest.iata)}</span>
          </div>
          {dest.minDuration > 0 && <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: C.muted, flexShrink: 0 }}>{fmtDur(dest.minDuration)}</span>}
        </div>
        {/* Row 2: Airline chips | Weekly badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {dest.airlines.slice(0, 4).map(a => (
            <AirlineLogo key={a.prefix} prefix={a.prefix} name={a.name} size={22} />
          ))}
          {dest.airlines.length > 4 && <span style={{ fontSize: 10, color: C.muted, alignSelf: 'center' }}>+{dest.airlines.length - 4}</span>}
          <div style={{ padding: '4px 9px', borderRadius: 999, background: badge, marginInlineStart: 'auto' }}>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10.5, color: '#fff' }}>{weeklyCount} {t('dest.per_week_short')}</span>
          </div>
        </div>
        <div style={{ borderTop: `1px dashed ${C.separator}`, paddingTop: 11, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {/* Day-of-week dots */}
          <div style={{ display: 'flex', gap: 3 }}>
            {(() => {
              const active = new Set(dest.flights.flatMap(f => f.days_of_week))
              return DOW_ORDER.map(d => (
                <span key={d} style={{ width: 20, height: 20, borderRadius: 99, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, background: active.has(d) ? C.forest : '#E8E5DC', color: active.has(d) ? '#fff' : C.muted }}>
                  {dowLabel(d, t)}
                </span>
              ))
            })()}
          </div>
          <button onClick={onView} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 9, background: C.forest, cursor: 'pointer', border: 'none' }}>
            <span style={{ font: `600 12px/1 'Instrument Sans',system-ui`, color: '#fff' }}>{t('action.view_flights')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Destination row — mobile ──────────────────────────────────────────────────
function DestRowMobile({ dest, onView, weeklyCount }: { dest: Destination; onView: () => void; weeklyCount: number }) {
  const t      = useT()
  const locale = useLocale()
  return (
    <button onClick={onView} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden', display: 'flex', width: '100%', textAlign: 'start', cursor: 'pointer' }}>
      {/* Thumbnail */}
      <div style={{ width: 100, flexShrink: 0, background: destBg(dest.iata), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 30, opacity: .4 }}>{apFlag(dest.iata)}</span>
      </div>
      {/* Info */}
      <div style={{ flex: 1, minWidth: 0, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={{ font: `700 14px/1 'Instrument Sans',system-ui`, color: C.ink }}>{destName(dest.iata)}</span>
          {dest.minDuration > 0 && <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: C.muted }}>{fmtDur(dest.minDuration)}</span>}
        </div>
        <span style={{ font: `500 10.5px/1 'Instrument Sans',system-ui`, color: C.muted }}>
          {apFlag(dest.iata)} {weeklyCount > 0 ? `${weeklyCount} ${t('dest.flights_per_wk')}` : ''}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 3 }}>
            {dest.airlines.slice(0, 3).map(a => (
              <AirlineLogo key={a.prefix} prefix={a.prefix} name={a.name} size={18} />
            ))}
          </div>
          {/* The arrow points the way the language runs, or it points back at the list. */}
          <span style={{ font: `600 11px/1 'Instrument Sans',system-ui`, color: C.forest }}>{t('action.view')} {locale === 'ar' ? '←' : '→'}</span>
        </div>
      </div>
    </button>
  )
}

// ── Detail panel (bottom sheet on mobile, side drawer on desktop) ─────────────

function BottomSheet({ dest, airport, onClose, imageUrl }: { dest: Destination | null; airport: string; onClose: () => void; imageUrl?: string }) {
  const t      = useT()
  const locale = useLocale()
  const rtl    = locale === 'ar'
  const [dir, setDir] = useState<'to'|'from'>('to')
  const [imgFailed, setImgFailed] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  useEffect(() => { if (dest) document.body.style.overflow = 'hidden'; else document.body.style.overflow = ''; return () => { document.body.style.overflow = '' } }, [dest])
  useEffect(() => { setDir('to'); setImgFailed(false) }, [dest?.iata])
  const flights = dir === 'to' ? (dest?.flights ?? []) : (dest?.reverseFlights ?? [])

  /**
   * One entry per flight number, not per timetable row.
   *
   * The same service appears several times when its departure shifts by day — XH485 to
   * Istanbul was three rows ten minutes apart. Read as three flights that is misleading; read
   * as one flight whose time moves it is the truth, and the day chips already carried what was
   * needed to say so. Same treatment as the airline panel.
   *
   * The earliest departure is the headline; any day can be tapped for its own time.
   */
  const collapsed = useMemo(() => {
    const byNum = new Map<string, ScheduleRow[]>()
    for (const f of flights) {
      if (!byNum.has(f.iata_number)) byNum.set(f.iata_number, [])
      byNum.get(f.iata_number)!.push(f)
    }
    return [...byNum.entries()]
      .map(([num, rows]) => {
        const byDay: Record<string, { dep: string; arr: string }> = {}
        for (const r of rows) for (const d of r.days_of_week ?? []) byDay[d] = { dep: r.dep_time, arr: r.arr_time }
        const earliest = [...rows].sort((a, b) => (a.dep_time ?? '').localeCompare(b.dep_time ?? ''))[0]
        return {
          num,
          row: earliest,
          byDay,
          days: new Set(Object.keys(byDay)),
          dep: earliest.dep_time,
          arr: earliest.arr_time,
          varies: new Set(rows.map(r => r.dep_time)).size > 1,
        }
      })
      .sort((a, b) => (a.dep ?? '').localeCompare(b.dep ?? ''))
  }, [flights])

  /** Which day is being inspected, per flight number. */
  const [pickedDay, setPickedDay] = useState<Record<string, string>>({})
  const hasReverse = (dest?.reverseFlights.length ?? 0) > 0

  const subtitle = dest ? [
    dest.weeklyCount ? `${dest.weeklyCount} ${t('dest.flights_week')}` : null,
    dest.airlines.length ? `${dest.airlines.length} ${t(dest.airlines.length > 1 ? 'dest.airline_many' : 'dest.airline_one')}` : null,
    dest.minDuration ? fmtDur(dest.minDuration) : null,
  ].filter(Boolean).join(' · ') : ''

  const airportName = city(airport)
  const showImg = imageUrl && !imgFailed

  const panelStyle: React.CSSProperties = isMobile ? {
    position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 50,
    maxHeight: 'min(86dvh, 86vh)', background: C.surface, borderRadius: '20px 20px 0 0',
    display: 'flex', flexDirection: 'column',
    transform: dest ? 'translateY(0)' : 'translateY(100%)',
    transition: 'transform .3s ease-out',
    boxShadow: '0 -20px 48px -12px rgba(22,22,22,.28)',
  } : {
    position: 'fixed', top: 0, insetInlineEnd: 0, bottom: 0, zIndex: 50,
    width: 'min(440px, 100vw)', background: C.surface,
    borderRadius: rtl ? '0 20px 20px 0' : '20px 0 0 20px',
    display: 'flex', flexDirection: 'column',
    // translateX is physical, so the hidden position has to be told which way is off-screen.
    transform: dest ? 'translateX(0)' : `translateX(${rtl ? '-100%' : '100%'})`,
    transition: 'transform .3s ease-out',
    boxShadow: `${rtl ? '' : '-'}20px 0 48px -12px rgba(22,22,22,.28)`,
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(22,22,22,.45)', opacity: dest ? 1 : 0, pointerEvents: dest ? 'auto' : 'none', transition: 'opacity .25s' }} />
      <div style={panelStyle}>
        {dest && (
          <>
            {/* Header */}
            <div style={{ padding: '20px 16px 0', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <span style={{ fontSize: 22 }}>{apFlag(dest.iata)}</span>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                  <span style={{ font: `700 19px/1.1 'Instrument Sans',system-ui`, color: C.ink, letterSpacing: '-.015em' }}>{destName(dest.iata)}</span>
                  <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, fontWeight: 600, color: C.muted, letterSpacing: '.06em' }}>{dest.iata}</span>
                </div>
                {subtitle && <span style={{ font: `500 11.5px/1 'Instrument Sans',system-ui`, color: C.muted }}>{subtitle}</span>}
              </div>
              <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 99, background: '#E4E1D2', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', font: `600 14px/1 'Instrument Sans',system-ui`, color: C.secondary, flexShrink: 0 }}>✕</button>
            </div>
            {/* Destination image */}
            <div style={{ margin: '12px 16px 0', borderRadius: 12, overflow: 'hidden', height: 160, flexShrink: 0, position: 'relative', background: destBg(dest.iata) }}>
              {showImg
                ? <img src={imageUrl} alt={destName(dest.iata)} onError={() => setImgFailed(true)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                : <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 48, opacity: .3 }}>{apFlag(dest.iata)}</span>
              }
            </div>
            {/* Direction toggle */}
            {hasReverse && (
              <div style={{ padding: '12px 16px 0', flexShrink: 0 }}>
                <div style={{ display: 'flex', background: '#E4E1D2', borderRadius: 11, padding: 3, gap: 3 }}>
                  {(['to','from'] as const).map(d => (
                    <button key={d} onClick={() => setDir(d)} style={{ flex: 1, padding: '8px 6px', borderRadius: 9, border: 'none', cursor: 'pointer', font: `${dir === d ? 700 : 600} 12px/1.2 'Instrument Sans',system-ui`, background: dir === d ? C.ink : 'transparent', color: dir === d ? '#fff' : C.muted, transition: 'all .15s' }}>
                      {(() => {
                        const arrow = rtl ? '←' : '→'
                        return d === 'to'
                          ? `${airportName} ${arrow} ${destName(dest.iata)}`
                          : `${destName(dest.iata)} ${arrow} ${airportName}`
                      })()}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Flight cards */}
            <div style={{ overflowY: 'auto', flex: 1, padding: '12px 16px 26px' }}>
              {collapsed.map(fl => {
                const f       = fl.row
                const prefix  = f.airline_iata || f.iata_number.slice(0, 2)
                const picked  = pickedDay[fl.num]
                const shown   = picked && fl.byDay[picked] ? fl.byDay[picked] : { dep: fl.dep, arr: fl.arr }
                return (
                  <div key={fl.num} style={{ border: `1px solid ${C.border}`, borderRadius: 14, background: C.surface, marginBottom: 8 }}>
                    <div style={{ padding: '14px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, background: C.sunken, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <AirlineLogo prefix={prefix} name={airlineNameFor(prefix, f.airline_name)} size={36} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ font: `600 14px/1.2 'Instrument Sans',system-ui`, color: C.ink, marginBottom: 3 }}>{airlineNameFor(prefix, f.airline_name)}</div>
                        <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, fontWeight: 500, color: C.muted, letterSpacing: '.06em' }}>{fl.num}</div>
                        {/* Said out loud rather than hidden: one headline time on a flight that
                            leaves at three different minutes is wrong on most days. */}
                        {fl.varies && (
                          <div style={{ font: `500 10.5px/1.4 'Instrument Sans',system-ui`, color: C.muted, marginTop: 2 }}>
                            {t(picked ? 'dest.time_for_day' : 'dest.time_varies')}
                          </div>
                        )}
                      </div>
                      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: 5 }}>
                        <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 15, fontWeight: 700, color: C.ink }}>{shown.dep}</span>
                        <span style={{ font: `500 11px/1 'Instrument Sans',system-ui`, color: C.muted }}>{rtl ? '←' : '→'}</span>
                        <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 15, fontWeight: 700, color: C.ink }}>{shown.arr}</span>
                      </div>
                    </div>
                    <div style={{ borderTop: `1px solid #E8E4D8`, background: C.sunken, borderRadius: '0 0 14px 14px', padding: '10px 14px' }}>
                      <div style={{ display: 'flex', gap: 5 }}>
                        {DOW_ORDER.map(d => {
                          const active = fl.days.has(d)
                          const on     = picked === d
                          return (
                            <button
                              key={d}
                              disabled={!active}
                              aria-pressed={on}
                              aria-label={active ? `${fl.num} — ${t(`dowfull.${d}`)} — ${t('a11y.departs')} ${fl.byDay[d]?.dep}` : undefined}
                              onClick={() => setPickedDay(p => ({ ...p, [fl.num]: p[fl.num] === d ? '' : d }))}
                              style={{
                                // Gold selected, forest operates, outline for no service —
                                // three hues rather than three weights. Matches the airline
                                // panel so the two read as the same control.
                                flex: 1, height: 24, borderRadius: 7, padding: 0,
                                boxSizing: 'border-box',
                                background: on ? C.gold : active ? C.forest : C.surface,
                                border: `1px solid ${on ? C.gold : active ? 'transparent' : C.border}`,
                                color: active ? '#fff' : '#B5AFA0',
                                font: `700 10px/22px 'Instrument Sans',system-ui`, textAlign: 'center',
                                cursor: active ? 'pointer' : 'default',
                              }}
                            >
                              {dowLabel(d, t)}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                )
              })}
              {flights.length === 0 && (
                <div style={{ padding: '32px 0', textAlign: 'center', color: C.muted, font: `500 13px/1.5 'Instrument Sans',system-ui` }}>{t('dest.no_flights')}</div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DestinationsPage() {
  const t = useT()
  const [rows, setRows]       = useState<ScheduleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [airport, setAirport] = useState<BoardAirport>('DAM')
  const [region, setRegion]   = useState<RegionId>('all')
  const [selected, setSelected] = useState<Destination|null>(null)
  const [weeklyCounts, setWeeklyCounts] = useState<Record<string,number>>({})
  const [destImages, setDestImages] = useState<Record<string,string>>({})

  useEffect(() => { loadGeoData() }, [])

  useEffect(() => {
    fetch('/api/dest-images').then(r => r.ok ? r.json() : null).then(d => { if (d?.images) setDestImages(d.images) }).catch(() => {})
  }, [])


  useEffect(() => {
    setLoading(true)
    fetch('/api/schedule')
      .then(r => r.json())
      .then(d => { if (d.ok) setRows(d.rows) })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetch(`/api/weekly-stats?airport=${airport}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d?.ok) return
        const map: Record<string,number> = {}
        const src = d.departures
        for (const { iata, count } of (src ?? [])) map[iata] = count
        setWeeklyCounts(map)
      })
      .catch(() => {})
  }, [airport])

  const destinations = useMemo((): Destination[] => {
    const fwd = rows.filter(r => r.dep_iata === airport)
    const rev = rows.filter(r => r.arr_iata === airport)
    const grouped = new Map<string, ScheduleRow[]>()
    for (const r of fwd) { if (!grouped.has(r.arr_iata)) grouped.set(r.arr_iata, []); grouped.get(r.arr_iata)!.push(r) }
    const revGrouped = new Map<string, ScheduleRow[]>()
    for (const r of rev) { if (!revGrouped.has(r.dep_iata)) revGrouped.set(r.dep_iata, []); revGrouped.get(r.dep_iata)!.push(r) }
    return Array.from(grouped.entries()).map(([iata, flights]) => {
      const seen = new Set<string>(); const airlines: AirlineChip[] = []
      for (const f of flights) {
        const p = f.airline_iata || f.iata_number.slice(0, 2)
        if (!seen.has(p)) { seen.add(p); airlines.push({ prefix: p, name: airlineNameFor(p, f.airline_name), flag: f.country_flag }) }
      }
      const durations = flights.map(f => f.duration_min).filter(Boolean)
      return {
        iata, region: REGION_MAP[iata] ?? 'gulf',
        airlines,
        flights: [...flights].sort((a,b) => a.dep_time.localeCompare(b.dep_time)),
        reverseFlights: [...(revGrouped.get(iata) ?? [])].sort((a,b) => a.dep_time.localeCompare(b.dep_time)),
        minDuration: durations.length ? Math.min(...durations) : 0,
        weeklyCount: weeklyCounts[iata] ?? 0,
      }
    }).sort((a,b) => (b.weeklyCount - a.weeklyCount) || city(a.iata).localeCompare(city(b.iata)))
  }, [rows, airport, weeklyCounts])

  const [search, setSearch] = useState('')

  /**
   * Region and text together.
   *
   * Matched against the city, the airport code and the airlines that fly there, because those
   * are the three things someone actually knows: "Dubai", "DXB", or "who flies Emirates". The
   * country is not stored per destination, so searching one falls to the city name — worth
   * saying, since the placeholder used to promise it.
   *
   * Case- and accent-insensitive: "dusseldorf" should find Düsseldorf, and nobody types the
   * umlaut on a phone.
   */
  const filtered = useMemo(() => {
    const byRegion = region === 'all' ? destinations : destinations.filter(d => d.region === region)
    const q = norm(search)
    if (!q) return byRegion
    return byRegion.filter(d =>
      norm(destName(d.iata)).includes(q)
      || norm(d.iata).includes(q)
      || d.airlines.some(a => norm(a.name).includes(q) || norm(a.prefix).includes(q)))
  }, [destinations, region, search])

  const totalDests  = destinations.length
  const totalFlights = Object.values(weeklyCounts).reduce((s,v) => s+v, 0)

  const handleClose = useCallback(() => setSelected(null), [])
  const handleImageUploaded = useCallback((iata: string, url: string) => {
    setDestImages(prev => ({ ...prev, [iata]: url }))
  }, [])

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: "'Instrument Sans',system-ui,sans-serif" }}>
      {/* This was a span inside a styled box — it looked like a search field and did nothing. */}
      <SiteNav active="Destinations" right={
        <div style={{ display: 'flex', width: 260, height: 38, borderRadius: 10, background: C.sunken, border: `1px solid ${C.border}`, alignItems: 'center', gap: 9, padding: '0 12px' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.9" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.3-4.3"/></svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('dest.search')}
            aria-label={t('dest.search_aria')}
            style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', font: `500 12.5px/1 'Instrument Sans',system-ui`, color: C.ink }}
          />
          {search && (
            <button onClick={() => setSearch('')} aria-label={t('action.clear_search')}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: C.muted, font: `600 15px/1 'Instrument Sans',system-ui`, padding: 0 }}>×</button>
          )}
        </div>
      } />

      <div className="dst-body" style={{ maxWidth: 1400, margin: '0 auto' }}>
        <style>{`
          .dst-body { padding: 26px 40px 48px !important; }
          .dst-map { height: 240px; overflow: hidden; }
          .dst-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 20px; }
          .dst-mobile-row { display: none; }
          /* Desktop: title left, then the airport toggle, then the counts. */
          .dst-head   { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
          .dst-title  { order: 1; margin: 0; margin-inline-end: auto; font-size: 34px; }
          .dst-toggle { order: 2; }
          .dst-counts { order: 3; display: flex; align-items: center; gap: 8px; }
          .dst-short  { display: none; }
          @media (max-width: 767px) {
            .dst-body { padding: 16px 14px 32px !important; }
            .dst-map { height: 200px; overflow: hidden; }
            .dst-grid { grid-template-columns: 1fr; gap: 14px; }
            /* Counts join the heading line and sit at its end; the airport toggle takes the
               next row. "Destinations" is a far wider word than "Airlines", so the title has
               to come down further for all three to clear 375px. */
            .dst-title  { font-size: 21px; }
            .dst-counts { order: 2; gap: 6px; }
            .dst-toggle { order: 3; flex-basis: 100%; }
            .dst-count-num { font-size: 12px !important; }
            .dst-count-lbl { font-size: 10px !important; }
            .dst-count-box { padding: 5px 8px !important; gap: 5px !important; }
            .dst-full   { display: none; }
            .dst-short  { display: inline; }
          }
          @media (min-width: 768px) and (max-width: 1099px) {
            .dst-body { padding: 22px 28px 40px !important; }
            .dst-grid { grid-template-columns: repeat(2,1fr); }
          }
        `}</style>


        {/* Title + stats */}
        <div className="dst-head">
          <h1 className="dst-title" style={{ fontFamily: "'Instrument Sans',system-ui", fontWeight: 700, lineHeight: 1, color: C.ink, letterSpacing: '-.025em' }}>{t('dest.title')}</h1>
          <div className="dst-counts">
            {totalDests > 0 && (
              <div className="dst-count-box" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 9, background: C.surface, border: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>
                <span className="dst-count-num" style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, fontWeight: 700, color: C.ink, lineHeight: 1 }}>{totalDests}</span>
                <span className="dst-count-lbl" style={{ font: `500 11px/1 'Instrument Sans',system-ui`, color: C.muted }}>{t('dest.count')}</span>
              </div>
            )}
            {totalFlights > 0 && (
              <div className="dst-count-box" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 9, background: C.surface, border: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>
                <span className="dst-count-num" style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, fontWeight: 700, color: C.ink, lineHeight: 1 }}>{totalFlights}</span>
                <span className="dst-count-lbl" style={{ font: `500 11px/1 'Instrument Sans',system-ui`, color: C.muted }}>{t('airlines.per_week')}</span>
              </div>
            )}
          </div>
          <div className="dst-toggle" style={{ display: 'flex', padding: 3, background: '#E4E1D2', borderRadius: 9, gap: 2, width: 'fit-content' }}>
            {BOARD_AIRPORTS.map(({ iata: code }) => (
              <button key={code} onClick={() => setAirport(code)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', background: airport===code ? C.forest : 'transparent', color: airport===code ? '#fff' : C.muted, transition: 'all .15s' }}>
                <span style={{ font: `${airport===code?700:600} 12px/1 'Instrument Sans',system-ui` }}>{city(code)}</span>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9.5, opacity: .7, lineHeight: 1 }}>{code}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Airport hero */}
        <div className="dst-map" style={{ marginBottom: 20 }}>
          <AirportHero airport={airport} totalDests={totalDests} totalFlights={totalFlights} />
        </div>

        {/* Region filter */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 28, flexWrap: 'wrap' as const }}>
          {REGION_FILTERS.map(r => {
            const count = r.id === 'all' ? destinations.length : destinations.filter(d => d.region === r.id).length
            const active = region === r.id
            return (
              <button key={r.id} onClick={() => setRegion(r.id)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 14px', borderRadius: 99, border: 'none', cursor: 'pointer', background: active ? C.ink : C.surface, color: active ? '#fff' : C.muted, boxShadow: active ? 'none' : `0 0 0 1px ${C.border}`, transition: 'all .15s', font: `${active ? 700 : 500} 12px/1 'Instrument Sans',system-ui`, whiteSpace: 'nowrap' as const }}>
                <span className="dst-full">{t(r.label)}</span>
                <span className="dst-short">{t(r.short)}</span>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, opacity: active ? .75 : .6 }}>{count}</span>
              </button>
            )
          })}
        </div>

        {/* Cards */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: C.muted, font: `500 14px/1 'Instrument Sans',system-ui` }}>{t('dest.loading')}</div>
        ) : filtered.length === 0 ? (
          /* Said out loud. Every section returns null when it has no matches, so without this
             a search that finds nothing renders a blank page — indistinguishable from a load
             that failed. */
          <div style={{ textAlign: 'center', padding: '60px 0', color: C.muted, font: `500 14px/1 'Instrument Sans',system-ui` }}>
            {t('dest.no_match')} “{search}”.
          </div>
        ) : (
          REGION_SECTIONS
            .filter(s => region === 'all' || region === s.id)
            .map(s => {
              const dests = filtered.filter(d => d.region === s.id)
              if (dests.length === 0) return null
              const weekTotal = dests.reduce((sum,d) => sum + (weeklyCounts[d.iata]??0), 0)
              return (
                <div key={s.id} style={{ marginBottom: 36 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
                    <h2 style={{ margin: 0, font: `700 19px/1 'Instrument Sans',system-ui`, color: C.ink, letterSpacing: '-.01em' }}>{t(s.label)}</h2>
                    <span style={{ font: `500 12px/1 'Instrument Sans',system-ui`, color: C.muted }}>{dests.length} {t('dest.routes')}{weekTotal>0?` · ${weekTotal} ${t('dest.flights_week')}`:''}</span>
                  </div>
                  {/* Desktop grid */}
                  <div className="dst-grid">
                    {dests.map(d => (
                      <DestCardDesktop key={d.iata} dest={d} weeklyCount={weeklyCounts[d.iata]??0} onView={() => setSelected(d)} imageUrl={destImages[d.iata]} onImageUploaded={handleImageUploaded} />
                    ))}
                  </div>
                  {/* Mobile list */}
                  <div className="dst-mobile-row">
                    {dests.map(d => (
                      <DestRowMobile key={d.iata} dest={d} weeklyCount={weeklyCounts[d.iata]??0} onView={() => setSelected(d)} />
                    ))}
                  </div>
                </div>
              )
            })
        )}

        {/* Footer */}
        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 18, display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
          <span style={{ font: `500 11.5px/1 'Instrument Sans',system-ui`, color: C.muted }}>© 2026 FlySyria</span>
          <span style={{ font: `500 11.5px/1 'Instrument Sans',system-ui`, color: C.muted }}>{BOARD_AIRPORTS.map(a => city(a.iata)).join(' · ')}</span>
          <div style={{ flex: 1 }} />
          <LanguageSwitch />
        </div>
      </div>

      <BottomSheet dest={selected} airport={airport} onClose={handleClose} imageUrl={selected ? destImages[selected.iata] : undefined} />
    </div>
  )
}

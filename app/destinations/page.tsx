'use client'

import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { AIRLINE_LOGOS, LOGO_WHITE_BG } from '@/lib/airlines'
import { airportCity, airportFlag as _apFlag, loadGeoData } from '@/lib/geo-data'

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

const city = (iata: string) => airportCity[iata] ?? iata
const apFlag = (iata: string) => _apFlag[iata] ?? ''

// Override display names where multiple airports share a city name
const DEST_NAME: Record<string, string> = {
  IST: 'Istanbul Airport',
  SAW: 'Istanbul Sabiha',
}
const destName = (iata: string) => DEST_NAME[iata] ?? city(iata)

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
const REGION_FILTERS: { id: RegionId; label: string }[] = [
  { id: 'all',    label: 'All regions' },
  { id: 'gulf',   label: 'Middle East & Gulf' },
  { id: 'europe', label: 'Europe & Turkey' },
]
const REGION_SECTIONS: { id: RegionId; label: string }[] = [
  { id: 'gulf',   label: 'Middle East & Gulf' },
  { id: 'europe', label: 'Europe & Turkey' },
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
const DOW_LABEL: Record<string,string> = { sun:'S', mon:'M', tue:'T', wed:'W', thu:'T', fri:'F', sat:'S' }

function fmtDur(min: number) {
  if (!min) return ''
  const h = Math.floor(min / 60), m = min % 60
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
const DestIcon = ({ color = C.forest }: { color?: string }) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 22V4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v18"/>
    <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/>
    <path d="M16 9h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-4"/>
    <path d="M10 6.5h2M10 10.5h2M10 14.5h2M10 18.5h2"/>
  </svg>
)

function NavBar() {
  const tabs = [
    { label: 'Flights',      href: '/board',        active: false },
    { label: 'Track',        href: '/',             active: false },
    { label: 'Destinations', href: '/destinations', active: true  },
    { label: 'Airlines',     href: '/airlines',     active: false },
    { label: 'News',         href: '/news',         active: false },
  ]
  return (
    <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', position: 'sticky', top: 0, zIndex: 20 }}>
      <style>{`
        .dst-nav { padding: 0 40px; height: 68px; gap: 28px; }
        .dst-tabs { display: flex; align-items: center; gap: 4px; margin-left: 14px; }
        .dst-search { display: flex; }
        .dst-spacer { display: block; flex: 1; }
        @media (max-width: 767px) {
          .dst-nav { padding: 0 14px; height: auto; flex-direction: column; gap: 10px; padding-top: 10px; }
          .dst-tabs { overflow-x: auto; margin-left: 0; gap: 0; scrollbar-width: none; padding-bottom: 8px; }
          .dst-tabs::-webkit-scrollbar { display: none; }
          .dst-search { display: none; }
          .dst-spacer { display: none; }
        }
      `}</style>
      <div className="dst-nav" style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <FlySyriaLogo />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ font: `700 16px/1 'Instrument Sans',system-ui`, color: C.ink, letterSpacing: '-.01em', whiteSpace: 'nowrap' }}>FlySyria</span>
          </div>
        </div>
        {/* Tabs */}
        <div className="dst-tabs">
          {tabs.map(t => (
            <Link key={t.label} href={t.href} style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 10, textDecoration: 'none',
              background: t.active ? C.sunken : 'transparent',
            }}>
              {t.label === 'Destinations' && <DestIcon color={t.active ? C.forest : C.muted} />}
              <span style={{ font: `${t.active ? 700 : 600} 13.5px/1 'Instrument Sans',system-ui`, color: t.active ? C.forest : C.secondary, whiteSpace: 'nowrap' }}>
                {t.label}
              </span>
            </Link>
          ))}
        </div>
        <div className="dst-spacer" />
        {/* Search */}
        <div className="dst-search" style={{ width: 260, height: 38, borderRadius: 10, background: C.sunken, border: `1px solid ${C.border}`, alignItems: 'center', gap: 9, padding: '0 12px' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.9" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.3-4.3"/></svg>
          <span style={{ font: `500 12.5px/1 'Instrument Sans',system-ui`, color: C.muted }}>Search a city or country</span>
        </div>
      </div>
    </div>
  )
}

// ── Airport hero image ────────────────────────────────────────────────────────
const AIRPORT_HERO: Record<string, { src: string; fallback: string; label: string }> = {
  DAM: { src: '/dam-hero.jpg', fallback: 'linear-gradient(135deg,#2E4A3E 0%,#1A2E28 100%)', label: 'Damascus' },
  ALP: { src: '/alp-hero.jpg', fallback: 'linear-gradient(135deg,#4A3828 0%,#2C2018 100%)', label: 'Aleppo'   },
}

function AirportHero({ airport, totalDests, totalFlights }: { airport: string; totalDests: number; totalFlights: number }) {
  const cfg = AIRPORT_HERO[airport] ?? AIRPORT_HERO.DAM
  const [imgFailed, setImgFailed] = useState(false)
  useEffect(() => { setImgFailed(false) }, [airport])

  const effectiveSrc = !imgFailed ? cfg.src : null

  return (
    <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', background: cfg.fallback, height: '100%' }}>
      {effectiveSrc && (
        <img
          key={effectiveSrc}
          src={effectiveSrc}
          alt={cfg.label}
          onError={() => setImgFailed(true)}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' }}
        />
      )}
      {/* Dark gradient overlay */}
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,.55) 0%, rgba(0,0,0,.1) 50%, transparent 100%)' }} />
      {/* Bottom label */}
      <div style={{ position: 'absolute', left: 18, bottom: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ font: `700 22px/1 'Instrument Sans',system-ui`, color: '#fff', letterSpacing: '-.02em', textShadow: '0 1px 8px rgba(0,0,0,.4)' }}>{cfg.label}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {totalDests > 0 && <span style={{ font: `600 12px/1 'Instrument Sans',system-ui`, color: 'rgba(255,255,255,.85)' }}>{totalDests} destinations</span>}
          {totalFlights > 0 && <span style={{ font: `600 12px/1 'Instrument Sans',system-ui`, color: 'rgba(255,255,255,.6)' }}>· {totalFlights} flights/week</span>}
        </div>
      </div>
      {/* Top-right: IATA badge */}
      <div style={{ position: 'absolute', right: 14, top: 14 }}>
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
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
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
        <button onClick={() => fileRef.current?.click()} disabled={uploading}
          style={{ position: 'absolute', right: 10, bottom: 10, display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, background: 'rgba(0,0,0,.38)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.18)', cursor: 'pointer', color: '#fff', font: `600 11px/1 'Instrument Sans',system-ui`, opacity: uploading ? .6 : 1 }}>
          {uploading ? 'Uploading…' : 'Photo'}
        </button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFile} />
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
          <div style={{ padding: '4px 9px', borderRadius: 999, background: badge, marginLeft: 'auto' }}>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10.5, color: '#fff' }}>{weeklyCount} / wk</span>
          </div>
        </div>
        <div style={{ borderTop: `1px dashed ${C.separator}`, paddingTop: 11, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {/* Day-of-week dots */}
          <div style={{ display: 'flex', gap: 3 }}>
            {(() => {
              const active = new Set(dest.flights.flatMap(f => f.days_of_week))
              return DOW_ORDER.map(d => (
                <span key={d} style={{ width: 20, height: 20, borderRadius: 99, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, background: active.has(d) ? C.forest : '#E8E5DC', color: active.has(d) ? '#fff' : C.muted }}>
                  {DOW_LABEL[d]}
                </span>
              ))
            })()}
          </div>
          <button onClick={onView} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 9, background: C.forest, cursor: 'pointer', border: 'none' }}>
            <span style={{ font: `600 12px/1 'Instrument Sans',system-ui`, color: '#fff' }}>View flights</span>
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Destination row — mobile ──────────────────────────────────────────────────
function DestRowMobile({ dest, onView, weeklyCount }: { dest: Destination; onView: () => void; weeklyCount: number }) {
  return (
    <button onClick={onView} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden', display: 'flex', width: '100%', textAlign: 'left', cursor: 'pointer' }}>
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
          {apFlag(dest.iata)} {weeklyCount > 0 ? `${weeklyCount} flights/wk` : ''}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 3 }}>
            {dest.airlines.slice(0, 3).map(a => (
              <AirlineLogo key={a.prefix} prefix={a.prefix} name={a.name} size={18} />
            ))}
          </div>
          <span style={{ font: `600 11px/1 'Instrument Sans',system-ui`, color: C.forest }}>View →</span>
        </div>
      </div>
    </button>
  )
}

// ── Detail panel (bottom sheet on mobile, side drawer on desktop) ─────────────

function BottomSheet({ dest, airport, onClose, imageUrl }: { dest: Destination | null; airport: string; onClose: () => void; imageUrl?: string }) {
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
  const hasReverse = (dest?.reverseFlights.length ?? 0) > 0

  const subtitle = dest ? [
    dest.weeklyCount ? `${dest.weeklyCount} flights this week` : null,
    dest.airlines.length ? `${dest.airlines.length} airline${dest.airlines.length > 1 ? 's' : ''}` : null,
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
    position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 50,
    width: 'min(440px, 100vw)', background: C.surface, borderRadius: '20px 0 0 20px',
    display: 'flex', flexDirection: 'column',
    transform: dest ? 'translateX(0)' : 'translateX(100%)',
    transition: 'transform .3s ease-out',
    boxShadow: '-20px 0 48px -12px rgba(22,22,22,.28)',
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
                      {d === 'to' ? `${airportName} → ${destName(dest.iata)}` : `${destName(dest.iata)} → ${airportName}`}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Flight cards */}
            <div style={{ overflowY: 'auto', flex: 1, padding: '12px 16px 26px' }}>
              {flights.map((f, i) => {
                const prefix = f.airline_iata || f.iata_number.slice(0, 2)
                const activeDays = new Set(f.days_of_week)
                return (
                  <div key={i} style={{ border: `1px solid ${C.border}`, borderRadius: 14, background: C.surface, marginBottom: 8 }}>
                    <div style={{ padding: '14px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, background: C.sunken, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <AirlineLogo prefix={prefix} name={f.airline_name} size={36} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ font: `600 14px/1.2 'Instrument Sans',system-ui`, color: C.ink, marginBottom: 3 }}>{f.airline_name}</div>
                        <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, fontWeight: 500, color: C.muted, letterSpacing: '.06em' }}>{f.iata_number}</div>
                      </div>
                      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: 5 }}>
                        <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 15, fontWeight: 700, color: C.ink }}>{f.dep_time}</span>
                        <span style={{ font: `500 11px/1 'Instrument Sans',system-ui`, color: C.muted }}>→</span>
                        <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 15, fontWeight: 700, color: C.ink }}>{f.arr_time}</span>
                      </div>
                    </div>
                    <div style={{ borderTop: `1px solid #E8E4D8`, background: C.sunken, borderRadius: '0 0 14px 14px', padding: '10px 14px' }}>
                      <div style={{ display: 'flex', gap: 5 }}>
                        {DOW_ORDER.map(d => (
                          <div key={d} style={{ flex: 1, height: 24, borderRadius: 7, background: activeDays.has(d) ? C.forest : C.surface, border: activeDays.has(d) ? 'none' : `1px solid ${C.border}`, color: activeDays.has(d) ? '#fff' : '#B5AFA0', font: `700 10px/24px 'Instrument Sans',system-ui`, textAlign: 'center' }}>
                            {DOW_LABEL[d]}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              })}
              {flights.length === 0 && (
                <div style={{ padding: '32px 0', textAlign: 'center', color: C.muted, font: `500 13px/1.5 'Instrument Sans',system-ui` }}>No scheduled flights found</div>
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
  const [rows, setRows]       = useState<ScheduleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [airport, setAirport] = useState<'DAM'|'ALP'>('DAM')
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
        const src = airport === 'DAM' ? d.departures : d.arrivals
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
        if (!seen.has(p)) { seen.add(p); airlines.push({ prefix: p, name: f.airline_name, flag: f.country_flag }) }
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

  const filtered = useMemo(() => region === 'all' ? destinations : destinations.filter(d => d.region === region), [destinations, region])

  const totalDests  = destinations.length
  const totalFlights = Object.values(weeklyCounts).reduce((s,v) => s+v, 0)

  const handleClose = useCallback(() => setSelected(null), [])
  const handleImageUploaded = useCallback((iata: string, url: string) => {
    setDestImages(prev => ({ ...prev, [iata]: url }))
  }, [])

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: "'Instrument Sans',system-ui,sans-serif" }}>
      <NavBar />

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '26px 40px 48px' }}>
        <style>{`
          .dst-body { padding: 26px 40px 48px !important; }
          .dst-map { height: 240px; overflow: hidden; }
          .dst-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 20px; }
          .dst-mobile-row { display: none; }
          @media (max-width: 767px) {
            .dst-body { padding: 16px 14px 32px !important; }
            .dst-map { height: 200px; overflow: hidden; }
            .dst-grid { grid-template-columns: 1fr; gap: 14px; }
            .dst-region-filter { display: none !important; }
          }
          @media (min-width: 768px) and (max-width: 1099px) {
            .dst-body { padding: 22px 28px 40px !important; }
            .dst-grid { grid-template-columns: repeat(2,1fr); }
          }
        `}</style>


        {/* Title + stats */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: `500 12px/1 'Instrument Sans',system-ui`, color: C.muted, letterSpacing: '.02em' }}>From Damascus &amp; Aleppo</span>
            <h1 style={{ margin: 0, font: `700 34px/1 'Instrument Sans',system-ui`, color: C.ink, letterSpacing: '-.025em' }}>Destinations</h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Airport toggle */}
            <div style={{ display: 'flex', padding: 3, background: '#E4E1D2', borderRadius: 9, gap: 2 }}>
              {([['DAM','Damascus'],['ALP','Aleppo']] as const).map(([code, label]) => (
                <button key={code} onClick={() => setAirport(code)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', background: airport===code ? C.forest : 'transparent', color: airport===code ? '#fff' : C.muted, transition: 'all .15s' }}>
                  <span style={{ font: `${airport===code?700:600} 12px/1 'Instrument Sans',system-ui` }}>{label}</span>
                  <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9.5, opacity: .7, lineHeight: 1 }}>{code}</span>
                </button>
              ))}
            </div>
            {totalDests > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 9, background: C.surface, border: `1px solid ${C.border}` }}>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, fontWeight: 700, color: C.ink, lineHeight: 1 }}>{totalDests}</span>
                <span style={{ font: `500 11px/1 'Instrument Sans',system-ui`, color: C.muted }}>destinations</span>
              </div>
            )}
            {totalFlights > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 9, background: C.surface, border: `1px solid ${C.border}` }}>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, fontWeight: 700, color: C.ink, lineHeight: 1 }}>{totalFlights}</span>
                <span style={{ font: `500 11px/1 'Instrument Sans',system-ui`, color: C.muted }}>flights / week</span>
              </div>
            )}
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
                {r.label}
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, opacity: active ? .75 : .6 }}>{count}</span>
              </button>
            )
          })}
        </div>

        {/* Cards */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: C.muted, font: `500 14px/1 'Instrument Sans',system-ui` }}>Loading destinations…</div>
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
                    <h2 style={{ margin: 0, font: `700 19px/1 'Instrument Sans',system-ui`, color: C.ink, letterSpacing: '-.01em' }}>{s.label}</h2>
                    <span style={{ font: `500 12px/1 'Instrument Sans',system-ui`, color: C.muted }}>{dests.length} routes{weekTotal>0?` · ${weekTotal} flights this week`:''}</span>
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
          <span style={{ font: `500 11.5px/1 'Instrument Sans',system-ui`, color: C.muted }}>Damascus · Aleppo</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11.5, color: '#A6A093' }}>العربية · English</span>
        </div>
      </div>

      <BottomSheet dest={selected} airport={airport} onClose={handleClose} imageUrl={selected ? destImages[selected.iata] : undefined} />
    </div>
  )
}

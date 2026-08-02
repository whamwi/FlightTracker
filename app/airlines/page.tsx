'use client'

import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { AIRLINE_LOGOS, LOGO_WHITE_BG } from '@/lib/airlines'
import { airportCity, airportFlag as _apFlag, loadGeoData } from '@/lib/geo-data'
import Wordmark from '@/components/Wordmark'

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

const DOW_ORDER = ['sun','mon','tue','wed','thu','fri','sat'] as const
const DOW_LABEL: Record<string,string> = { sun:'S', mon:'M', tue:'T', wed:'W', thu:'T', fri:'F', sat:'S' }

function fmtDur(min: number) {
  if (!min) return ''
  const h = Math.floor(min / 60), m = min % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

// ── Airline brand gradients ───────────────────────────────────────────────────
const AIRLINE_BG: Record<string, string> = {
  RB:  'linear-gradient(140deg,#1A4A2E 0%,#0D2818 100%)',
  XH:  'linear-gradient(140deg,#C4A060 0%,#7A5820 100%)',
  TK:  'linear-gradient(140deg,#B82030 0%,#681018 100%)',
  EY:  'linear-gradient(140deg,#C8AA70 0%,#806838 100%)',
  J9:  'linear-gradient(140deg,#207080 0%,#104048 100%)',
  FZ:  'linear-gradient(140deg,#C03040 0%,#701828 100%)',
  G9:  'linear-gradient(140deg,#B82028 0%,#601018 100%)',
  '3L':'linear-gradient(140deg,#B82028 0%,#601018 100%)',
  FYC: 'linear-gradient(140deg,#2858A8 0%,#102860 100%)',
  SV:  'linear-gradient(140deg,#006747 0%,#003824 100%)',
  ME:  'linear-gradient(140deg,#006633 0%,#003320 100%)',
  RJ:  'linear-gradient(140deg,#006233 0%,#003018 100%)',
  MS:  'linear-gradient(140deg,#C09050 0%,#705828 100%)',
  LH:  'linear-gradient(140deg,#0050A0 0%,#002860 100%)',
  AF:  'linear-gradient(140deg,#002395 0%,#001255 100%)',
  KL:  'linear-gradient(140deg,#009FE3 0%,#005880 100%)',
  AZ:  'linear-gradient(140deg,#006CA9 0%,#003860 100%)',
  OS:  'linear-gradient(140deg,#BA0020 0%,#680010 100%)',
  LO:  'linear-gradient(140deg,#005CA9 0%,#003060 100%)',
  PC:  'linear-gradient(140deg,#F47920 0%,#904010 100%)',
  W6:  'linear-gradient(140deg,#FF6600 0%,#903800 100%)',
  '6Q':'linear-gradient(140deg,#204080 0%,#102040 100%)',
  XQ:  'linear-gradient(140deg,#1A5090 0%,#0A2850 100%)',
}
const airlineBg = (prefix: string) => AIRLINE_BG[prefix] ?? 'linear-gradient(140deg,#607080 0%,#303840 100%)'

const AIRLINE_REGION: Record<string, 'gulf' | 'europe'> = {
  '3L':'gulf', EK:'gulf', EY:'gulf', F3:'gulf', FZ:'gulf', G9:'gulf',
  J9:'gulf',  KU:'gulf', QR:'gulf', RB:'gulf', RJ:'gulf', XH:'gulf', XY:'gulf',
  DN:'europe', KK:'europe', PC:'europe', SR:'europe', TK:'europe', VF:'europe', XQ:'europe', '42':'europe',
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface ScheduleRow {
  dep_iata: string; arr_iata: string; dep_time: string; arr_time: string
  duration_min: number; days_of_week: string[]; iata_number: string
  airline_iata: string; airline_name: string; country_flag: string
}
interface DestChip { iata: string; name: string; flag: string }
interface AirlineInfo {
  prefix: string; name: string; flag: string; region: 'gulf' | 'europe'
  routes: ScheduleRow[]
  reverseRoutes: ScheduleRow[]
  dests: DestChip[]
  weeklyCount: number
  activeDays: Set<string>
  minDuration: number
}

// ── Airline logo ──────────────────────────────────────────────────────────────
function AirlineLogo({ prefix, name, size = 22 }: { prefix: string; name: string; size?: number }) {
  const [src, setSrc] = useState(AIRLINE_LOGOS[prefix] ?? `https://images.flightsfrom.com/airlines/100/${prefix}_100px.png`)
  const [failed, setFailed] = useState(false)
  if (failed) return <span style={{ fontSize: Math.round(size * 0.6), lineHeight: 1 }} title={name}>✈</span>
  return (
    <img src={src} alt={name} title={name} width={size} height={size}
      style={{ borderRadius: Math.round(size * 0.22), objectFit: 'cover', background: LOGO_WHITE_BG.has(prefix) ? '#fff' : undefined }}
      onError={() => { if (AIRLINE_LOGOS[prefix] && src === AIRLINE_LOGOS[prefix]) setSrc(`https://images.flightsfrom.com/airlines/100/${prefix}_100px.png`); else setFailed(true) }}
    />
  )
}

// ── Nav bar ───────────────────────────────────────────────────────────────────
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
    { label: 'Destinations', href: '/destinations', active: false },
    { label: 'Airlines',     href: '/airlines',     active: true  },
    { label: 'News',         href: '/news',         active: false },
  ]
  return (
    <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', position: 'sticky', top: 0, zIndex: 20 }}>
      <style>{`
        .al-nav { padding: 0 40px; height: 68px; gap: 28px; }
        .al-tabs { display: flex; align-items: center; gap: 4px; margin-left: 14px; }
        .al-search { display: flex; }
        .al-spacer { display: block; flex: 1; }
        @media (max-width: 767px) {
          .al-nav { padding: 0 14px; height: auto; flex-direction: column; gap: 10px; padding-top: 10px; }
          .al-tabs { overflow-x: auto; margin-left: 0; gap: 0; scrollbar-width: none; padding-bottom: 8px; }
          .al-tabs::-webkit-scrollbar { display: none; }
          .al-search { display: none; }
          .al-spacer { display: none; }
        }
      `}</style>
      <div className="al-nav" style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
        <Wordmark />
        <div className="al-tabs">
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
        <div className="al-spacer" />
        <div className="al-search" style={{ width: 260, height: 38, borderRadius: 10, background: C.sunken, border: `1px solid ${C.border}`, alignItems: 'center', gap: 9, padding: '0 12px' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.9" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.3-4.3"/></svg>
          <span style={{ font: `500 12.5px/1 'Instrument Sans',system-ui`, color: C.muted }}>Search airlines</span>
        </div>
      </div>
    </div>
  )
}

// ── Airport hero ──────────────────────────────────────────────────────────────
const AIRPORT_HERO: Record<string, { src: string; fallback: string; label: string }> = {
  DAM: { src: '/dam-hero.jpg', fallback: 'linear-gradient(135deg,#2E4A3E 0%,#1A2E28 100%)', label: 'Damascus' },
  ALP: { src: '/alp-hero.jpg', fallback: 'linear-gradient(135deg,#4A3828 0%,#2C2018 100%)', label: 'Aleppo'   },
}
function AirportHero({ airport, totalAirlines, totalFlights }: { airport: string; totalAirlines: number; totalFlights: number }) {
  const cfg = AIRPORT_HERO[airport] ?? AIRPORT_HERO.DAM
  const [imgFailed, setImgFailed] = useState(false)
  useEffect(() => { setImgFailed(false) }, [airport])
  const effectiveSrc = !imgFailed ? cfg.src : null
  return (
    <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', background: cfg.fallback, height: '100%' }}>
      {effectiveSrc && (
        <img key={effectiveSrc} src={effectiveSrc} alt={cfg.label} onError={() => setImgFailed(true)}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' }} />
      )}
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,.55) 0%, rgba(0,0,0,.1) 50%, transparent 100%)' }} />
      <div style={{ position: 'absolute', left: 18, bottom: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ font: `700 22px/1 'Instrument Sans',system-ui`, color: '#fff', letterSpacing: '-.02em', textShadow: '0 1px 8px rgba(0,0,0,.4)' }}>{cfg.label}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {totalAirlines > 0 && <span style={{ font: `600 12px/1 'Instrument Sans',system-ui`, color: 'rgba(255,255,255,.85)' }}>{totalAirlines} airlines</span>}
          {totalFlights > 0 && <span style={{ font: `600 12px/1 'Instrument Sans',system-ui`, color: 'rgba(255,255,255,.6)' }}>· {totalFlights} flights/week</span>}
        </div>
      </div>
      <div style={{ position: 'absolute', right: 14, top: 14 }}>
        <div style={{ padding: '5px 10px', borderRadius: 8, background: 'rgba(0,0,0,.35)', backdropFilter: 'blur(6px)' }}>
          <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, fontWeight: 700, color: '#fff', letterSpacing: '.08em' }}>{airport}</span>
        </div>
      </div>
    </div>
  )
}

// ── Airline card ──────────────────────────────────────────────────────────────
function AirlineCard({ info, onView, imageUrl, onImageUploaded }: {
  info: AirlineInfo; onView: () => void; imageUrl?: string; onImageUploaded: (prefix: string, url: string) => void
}) {
  const badge = info.weeklyCount >= 14 ? C.forest : C.gold
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  useEffect(() => { setImgFailed(false) }, [imageUrl])

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setUploading(true)
    setUploadErr(null)
    try {
      const form = new FormData()
      form.append('prefix', info.prefix)
      form.append('file', file)
      const res = await fetch('/api/airline-images', { method: 'POST', body: form })
      const data = await res.json().catch(() => null)
      // A rejected upload used to leave no trace at all: the button returned to "Photo" and
      // the old picture stayed, which is indistinguishable from a silently ignored click.
      if (data?.ok) onImageUploaded(info.prefix, data.url)
      else setUploadErr(data?.error ?? `Upload failed (${res.status})`)
    } catch (err) {
      setUploadErr(String(err))
    } finally {
      setUploading(false)
    }
  }

  const showPhoto = imageUrl && !imgFailed

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, overflow: 'hidden', boxShadow: '0 1px 2px rgba(22,22,22,.05),0 12px 26px -22px rgba(22,22,22,.5)', display: 'flex', flexDirection: 'column' }}>
      {/* Photo / logo area */}
      <div style={{ position: 'relative', height: 160, background: airlineBg(info.prefix), display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {showPhoto ? (
          <img src={imageUrl} alt={info.name} onError={() => setImgFailed(true)}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{ width: 88, height: 88, borderRadius: 20, background: 'rgba(255,255,255,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
            <AirlineLogo prefix={info.prefix} name={info.name} size={68} />
          </div>
        )}
        {showPhoto && <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,.45) 0%, transparent 60%)' }} />}
        {/* Upload button bottom-right */}
        <button onClick={() => fileRef.current?.click()} disabled={uploading}
          style={{ position: 'absolute', right: 10, bottom: 10, display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, background: 'rgba(0,0,0,.38)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.18)', cursor: 'pointer', color: '#fff', font: `600 11px/1 'Instrument Sans',system-ui`, opacity: uploading ? .6 : 1 }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          {uploading ? 'Uploading…' : 'Photo'}
        </button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFile} />
        {uploadErr && (
          <div style={{ position: 'absolute', left: 10, right: 10, bottom: 10, padding: '6px 9px', borderRadius: 8, background: 'rgba(153,27,27,.92)', color: '#fff', font: `600 10.5px/1.35 'Instrument Sans',system-ui` }}>
            {uploadErr}
          </div>
        )}
      </div>
      {/* Info */}
      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 9, flex: 1 }}>
        {/* Airline name + logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <AirlineLogo prefix={info.prefix} name={info.name} size={32} />
            <span style={{ font: `700 15px/1.2 'Instrument Sans',system-ui`, color: C.ink, letterSpacing: '-.01em' }}>{info.name}</span>
          </div>
          {info.minDuration > 0 && <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: C.muted, flexShrink: 0 }}>{fmtDur(info.minDuration)}</span>}
        </div>
        {/* Destination chips + weekly badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          {info.dests.slice(0, 5).map(d => (
            <div key={d.iata} style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '3px 7px', borderRadius: 6, background: C.sunken, border: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 11 }}>{d.flag}</span>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9.5, color: C.secondary, letterSpacing: '.04em' }}>{d.iata}</span>
            </div>
          ))}
          {info.dests.length > 5 && <span style={{ fontSize: 10, color: C.muted, alignSelf: 'center' }}>+{info.dests.length - 5}</span>}
          <div style={{ padding: '4px 9px', borderRadius: 999, background: badge, marginLeft: 'auto' }}>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10.5, color: '#fff' }}>{info.weeklyCount} / wk</span>
          </div>
        </div>
        <div style={{ borderTop: `1px dashed ${C.separator}`, paddingTop: 11, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 3 }}>
            {DOW_ORDER.map(d => (
              <span key={d} style={{ width: 20, height: 20, borderRadius: 99, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, background: info.activeDays.has(d) ? C.forest : '#E8E5DC', color: info.activeDays.has(d) ? '#fff' : C.muted }}>
                {DOW_LABEL[d]}
              </span>
            ))}
          </div>
          <button onClick={onView} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 9, background: C.forest, cursor: 'pointer', border: 'none' }}>
            <span style={{ font: `600 12px/1 'Instrument Sans',system-ui`, color: '#fff' }}>View routes</span>
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Detail panel ──────────────────────────────────────────────────────────────
function AirlineSheet({ info, airport, onClose, imageUrl }: { info: AirlineInfo | null; airport: string; onClose: () => void; imageUrl?: string }) {
  const [dir, setDir] = useState<'from'|'to'>('from')
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  useEffect(() => {
    if (info) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
    return () => { document.body.style.overflow = '' }
  }, [info])
  useEffect(() => { setDir('from') }, [info?.prefix])

  const flights = dir === 'from' ? (info?.routes ?? []) : (info?.reverseRoutes ?? [])
  const hasReverse = (info?.reverseRoutes.length ?? 0) > 0
  const airportLabel = city(airport)

  const panelStyle: React.CSSProperties = isMobile ? {
    position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 50,
    maxHeight: 'min(86dvh, 86vh)', background: C.surface, borderRadius: '20px 20px 0 0',
    display: 'flex', flexDirection: 'column',
    transform: info ? 'translateY(0)' : 'translateY(100%)',
    transition: 'transform .3s ease-out',
    boxShadow: '0 -20px 48px -12px rgba(22,22,22,.28)',
  } : {
    position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 50,
    width: 'min(440px, 100vw)', background: C.surface, borderRadius: '20px 0 0 20px',
    display: 'flex', flexDirection: 'column',
    transform: info ? 'translateX(0)' : 'translateX(100%)',
    transition: 'transform .3s ease-out',
    boxShadow: '-20px 0 48px -12px rgba(22,22,22,.28)',
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(22,22,22,.45)', opacity: info ? 1 : 0, pointerEvents: info ? 'auto' : 'none', transition: 'opacity .25s' }} />
      <div style={panelStyle}>
        {info && (
          <>
            {/* Photo hero */}
            <div style={{ position: 'relative', height: 180, background: airlineBg(info.prefix), flexShrink: 0, overflow: 'hidden' }}>
              {imageUrl && <img src={imageUrl} alt={info.name} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,.65) 0%, rgba(0,0,0,.1) 55%, transparent 100%)' }} />
              <button onClick={onClose} style={{ position: 'absolute', right: 12, top: 12, width: 32, height: 32, borderRadius: 99, background: 'rgba(0,0,0,.35)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff', font: `600 15px/1 'Instrument Sans',system-ui` }}>✕</button>
              <div style={{ position: 'absolute', left: 16, bottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
                <AirlineLogo prefix={info.prefix} name={info.name} size={44} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                    <span style={{ font: `700 19px/1.1 'Instrument Sans',system-ui`, color: '#fff', letterSpacing: '-.015em', textShadow: '0 1px 6px rgba(0,0,0,.4)' }}>{info.name}</span>
                    <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,.65)', letterSpacing: '.06em' }}>{info.prefix}</span>
                  </div>
                  <span style={{ font: `500 11.5px/1 'Instrument Sans',system-ui`, color: 'rgba(255,255,255,.75)' }}>
                    {info.weeklyCount} flights/week · {info.dests.length} destination{info.dests.length !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>
            </div>

            {/* Direction toggle */}
            {hasReverse && (
              <div style={{ padding: '12px 16px 0', flexShrink: 0 }}>
                <div style={{ display: 'flex', background: '#E4E1D2', borderRadius: 11, padding: 3, gap: 3 }}>
                  {(['from','to'] as const).map(d => (
                    <button key={d} onClick={() => setDir(d)} style={{ flex: 1, padding: '8px 6px', borderRadius: 9, border: 'none', cursor: 'pointer', font: `${dir === d ? 700 : 600} 12px/1.2 'Instrument Sans',system-ui`, background: dir === d ? C.ink : 'transparent', color: dir === d ? '#fff' : C.muted, transition: 'all .15s' }}>
                      {d === 'from' ? `From ${airportLabel}` : `To ${airportLabel}`}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Route cards */}
            <div style={{ overflowY: 'auto', flex: 1, padding: '12px 16px 26px' }}>
              {flights.map((f, i) => {
                const destIata = dir === 'from' ? f.arr_iata : f.dep_iata
                const activeDays = new Set(f.days_of_week)
                return (
                  <div key={i} style={{ border: `1px solid ${C.border}`, borderRadius: 14, background: C.surface, marginBottom: 8 }}>
                    <div style={{ padding: '14px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, background: C.sunken, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>
                        {apFlag(destIata)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ font: `600 14px/1.2 'Instrument Sans',system-ui`, color: C.ink, marginBottom: 3 }}>{city(destIata)}</div>
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
export default function AirlinesPage() {
  const [rows, setRows]             = useState<ScheduleRow[]>([])
  const [loading, setLoading]       = useState(true)
  const [airport, setAirport]       = useState<'DAM'|'ALP'>('DAM')
  const [region, setRegion]         = useState<'all'|'gulf'|'europe'>('all')
  const [selected, setSelected]     = useState<AirlineInfo|null>(null)
  const [airlineImages, setAirlineImages] = useState<Record<string,string>>({})

  useEffect(() => { loadGeoData() }, [])

  useEffect(() => {
    fetch('/api/airline-images')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.images) setAirlineImages(d.images) })
      .catch(() => {})
  }, [])

  const handleImageUploaded = useCallback((prefix: string, url: string) => {
    setAirlineImages(prev => ({ ...prev, [prefix]: url }))
  }, [])

  useEffect(() => {
    setLoading(true)
    fetch('/api/schedule')
      .then(r => r.json())
      .then(d => { if (d.ok) setRows(d.rows) })
      .finally(() => setLoading(false))
  }, [])

  const airlines = useMemo((): AirlineInfo[] => {
    const map = new Map<string, AirlineInfo>()
    for (const r of rows) {
      const prefix = r.airline_iata || r.iata_number.slice(0, 2)
      if (!map.has(prefix)) {
        map.set(prefix, { prefix, name: r.airline_name, flag: r.country_flag, region: AIRLINE_REGION[prefix] ?? 'gulf', routes: [], reverseRoutes: [], dests: [], weeklyCount: 0, activeDays: new Set(), minDuration: 0 })
      }
      const info = map.get(prefix)!
      if (r.dep_iata === airport) {
        info.routes.push(r)
        info.weeklyCount += r.days_of_week.length
        for (const d of r.days_of_week) info.activeDays.add(d)
        if (!info.dests.find(d => d.iata === r.arr_iata)) {
          info.dests.push({ iata: r.arr_iata, name: city(r.arr_iata), flag: apFlag(r.arr_iata) })
        }
        if (r.duration_min && (!info.minDuration || r.duration_min < info.minDuration)) info.minDuration = r.duration_min
      } else if (r.arr_iata === airport) {
        info.reverseRoutes.push(r)
      }
    }
    return Array.from(map.values())
      .filter(a => a.routes.length > 0)
      .sort((a, b) => b.weeklyCount - a.weeklyCount || a.name.localeCompare(b.name))
  }, [rows, airport])

  const totalFlights = useMemo(() => airlines.reduce((s, a) => s + a.weeklyCount, 0), [airlines])
  const handleClose = useCallback(() => setSelected(null), [])

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: "'Instrument Sans',system-ui,sans-serif" }}>
      <NavBar />

      <div className="al-body" style={{ maxWidth: 1400, margin: '0 auto', padding: '26px 40px 48px' }}>
        <style>{`
          .al-body { padding: 26px 40px 48px !important; }
          .al-map { height: 240px; overflow: hidden; }
          .al-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 20px; }
          @media (max-width: 767px) {
            .al-body { padding: 16px 14px 32px !important; }
            .al-map { height: 200px; overflow: hidden; }
            .al-grid { grid-template-columns: 1fr; gap: 14px; }
          }
          @media (min-width: 768px) and (max-width: 1099px) {
            .al-body { padding: 22px 28px 40px !important; }
            .al-grid { grid-template-columns: repeat(2,1fr); }
          }
        `}</style>

        {/* Title + stats */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: `500 12px/1 'Instrument Sans',system-ui`, color: C.muted, letterSpacing: '.02em' }}>From Damascus &amp; Aleppo</span>
            <h1 style={{ margin: 0, font: `700 34px/1 'Instrument Sans',system-ui`, color: C.ink, letterSpacing: '-.025em' }}>Airlines</h1>
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
            {airlines.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 9, background: C.surface, border: `1px solid ${C.border}` }}>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, fontWeight: 700, color: C.ink, lineHeight: 1 }}>{airlines.length}</span>
                <span style={{ font: `500 11px/1 'Instrument Sans',system-ui`, color: C.muted }}>airlines</span>
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
        <div className="al-map" style={{ marginBottom: 28 }}>
          <AirportHero airport={airport} totalAirlines={airlines.length} totalFlights={totalFlights} />
        </div>

        {/* Region filter tabs */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 24, flexWrap: 'wrap' as const }}>
          {([
            { id: 'all',    label: 'All regions',      count: airlines.length },
            { id: 'gulf',   label: 'Middle East & Gulf', count: airlines.filter(a => a.region === 'gulf').length },
            { id: 'europe', label: 'Europe & Turkey',  count: airlines.filter(a => a.region === 'europe').length },
          ] as const).map(tab => {
            const active = region === tab.id
            return (
              <button key={tab.id} onClick={() => setRegion(tab.id)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 14px', borderRadius: 99, border: 'none', cursor: 'pointer', background: active ? C.ink : C.surface, color: active ? '#fff' : C.muted, boxShadow: active ? 'none' : `0 0 0 1px ${C.border}`, transition: 'all .15s', font: `${active ? 700 : 500} 12px/1 'Instrument Sans',system-ui` }}>
                {tab.label}
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, opacity: active ? .75 : .6 }}>{tab.count}</span>
              </button>
            )
          })}
        </div>

        {/* Airline cards */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: C.muted, font: `500 14px/1 'Instrument Sans',system-ui` }}>Loading airlines…</div>
        ) : airlines.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: C.muted, font: `500 14px/1 'Instrument Sans',system-ui` }}>No airlines found</div>
        ) : (
          <>
            {(['gulf', 'europe'] as const).map(r => {
              if (region !== 'all' && region !== r) return null
              const group = airlines.filter(a => a.region === r)
              if (!group.length) return null
              const label = r === 'gulf' ? 'Middle East & Gulf' : 'Europe & Turkey'
              return (
                <div key={r} style={{ marginBottom: 36 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                    <span style={{ font: `700 13px/1 'Instrument Sans',system-ui`, color: C.muted, letterSpacing: '.06em', textTransform: 'uppercase' }}>{label}</span>
                    <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: C.muted, opacity: .6 }}>{group.length}</span>
                    <div style={{ flex: 1, height: 1, background: C.separator }} />
                  </div>
                  <div className="al-grid">
                    {group.map(a => (
                      <AirlineCard key={a.prefix} info={a} onView={() => setSelected(a)} imageUrl={airlineImages[a.prefix]} onImageUploaded={handleImageUploaded} />
                    ))}
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>

      <AirlineSheet info={selected} airport={airport} onClose={handleClose} imageUrl={selected ? airlineImages[selected.prefix] : undefined} />
    </div>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  bg:        '#EDEBE0',
  surface:   '#FFFFFF',
  border:    '#D8D3BF',
  ink:       '#161616',
  muted:     '#8A8578',
  secondary: '#3D3A3B',
  forest:    '#054239',
  gold:      '#988561',
  sunken:    '#F7F5EC',
}

// Arabic-capable stack — deliberately no Cairo.
const AR_FONT = "'Instrument Sans','Segoe UI',Tahoma,Arial,sans-serif"

const PAGE_SIZE = 24

type Media = {
  media_id:   string
  source:     'facebook' | 'youtube'
  media_type: 'photo' | 'video'
  video_id:   string | null
  caption:    string | null
  permalink:  string
  posted_at:  string | null
  image_url:  string | null
  thumb_url:  string
  width:      number | null
  height:     number | null
}

const isArabic = (s: string) => /[؀-ۿ]/.test(s)

function fmtDate(iso: string | null) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Damascus',
  })
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

function NavBar() {
  const tabs = [
    { label: 'Flights',      href: '/board',        active: false },
    { label: 'Track',        href: '/',             active: false },
    { label: 'Destinations', href: '/destinations', active: false },
    { label: 'Airlines',     href: '/airlines',     active: false },
    { label: 'News',         href: '/news',         active: true  },
  ]
  return (
    <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', position: 'sticky', top: 0, zIndex: 20 }}>
      <style>{`
        .nw-nav { padding: 0 40px; height: 68px; gap: 28px; }
        .nw-tabs { display: flex; align-items: center; gap: 4px; margin-left: 14px; }
        @media (max-width: 767px) {
          .nw-nav { padding: 0 14px; height: auto; flex-direction: column; gap: 10px; padding-top: 10px; }
          .nw-tabs { overflow-x: auto; margin-left: 0; gap: 0; scrollbar-width: none; padding-bottom: 8px; }
          .nw-tabs::-webkit-scrollbar { display: none; }
        }
      `}</style>
      <div className="nw-nav" style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <FlySyriaLogo />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ font: `700 16px/1 'Instrument Sans',system-ui`, color: C.ink, letterSpacing: '-.01em', whiteSpace: 'nowrap' }}>FlySyria Tracker</span>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: C.muted, letterSpacing: '.1em' }}>DAM · ALP</span>
          </div>
        </div>
        <div className="nw-tabs">
          {tabs.map(t => (
            <Link key={t.label} href={t.href} style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 10, textDecoration: 'none',
              background: t.active ? C.sunken : 'transparent',
            }}>
              <span style={{ font: `${t.active ? 700 : 600} 13.5px/1 'Instrument Sans',system-ui`, color: t.active ? C.forest : C.secondary, whiteSpace: 'nowrap' }}>
                {t.label}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

const PlayBadge = () => (
  <div style={{
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(5,66,57,.28)', pointerEvents: 'none',
  }}>
    <div style={{
      width: 46, height: 46, borderRadius: '50%', background: 'rgba(255,255,255,.92)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill={C.forest}><path d="M8 5v14l11-7z"/></svg>
    </div>
  </div>
)

// ── Card ──────────────────────────────────────────────────────────────────────
function Card({ m, onOpen }: { m: Media; onOpen: (m: Media) => void }) {
  const rtl = !!m.caption && isArabic(m.caption)

  const body = (
    <>
      <div style={{ position: 'relative', aspectRatio: '4 / 3', background: C.sunken, overflow: 'hidden' }}>
        <img
          src={m.thumb_url}
          alt={m.caption?.slice(0, 120) ?? 'SyrGACA media'}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        {m.media_type === 'video' && <PlayBadge />}
      </div>
      <div style={{ padding: '11px 12px 12px' }}>
        {m.caption && (
          <p dir={rtl ? 'rtl' : 'ltr'} style={{
            margin: 0, font: `500 13px/1.55 ${AR_FONT}`, color: C.secondary,
            textAlign: rtl ? 'right' : 'left',
            display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {m.caption}
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
          <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10.5, color: C.muted, letterSpacing: '.04em' }}>
            {fmtDate(m.posted_at)}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ font: `600 10.5px/1 'Instrument Sans',system-ui`, color: C.gold, letterSpacing: '.06em' }}>
            {m.media_type === 'video' ? 'VIDEO' : 'PHOTO'}
          </span>
        </div>
      </div>
    </>
  )

  const shell = {
    background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14,
    overflow: 'hidden', textDecoration: 'none', display: 'block', cursor: 'pointer',
  } as const

  // Photos and YouTube videos both open in the lightbox — the video just renders an
  // embedded player there instead of an image.
  return (
    <div style={shell} onClick={() => onOpen(m)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(m) }}>
      {body}
    </div>
  )
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function Lightbox({ m, onClose }: { m: Media; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = '' }
  }, [onClose])

  const rtl = !!m.caption && isArabic(m.caption)

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(10,14,13,.88)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900, width: '100%', maxHeight: '92vh', overflowY: 'auto' }}>
        {m.media_type === 'video' && m.video_id ? (
          <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', borderRadius: 12, overflow: 'hidden', background: '#000' }}>
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${m.video_id}?rel=0`}
              title={m.caption ?? 'SyrGACA video'}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
            />
          </div>
        ) : (
          <img src={m.image_url ?? m.thumb_url} alt={m.caption?.slice(0, 120) ?? ''}
            style={{ width: '100%', borderRadius: 12, display: 'block' }} />
        )}
        {m.caption && (
          <p dir={rtl ? 'rtl' : 'ltr'} style={{
            font: `500 14px/1.7 ${AR_FONT}`, color: '#EDEBE0', marginTop: 14,
            textAlign: rtl ? 'right' : 'left', whiteSpace: 'pre-wrap',
          }}>
            {m.caption}
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: '#9A9588' }}>
            {fmtDate(m.posted_at)}
          </span>
          {/* Attribution back to the authority's own post. */}
          <a href={m.permalink} target="_blank" rel="noopener noreferrer"
            style={{ font: `600 12px/1 'Instrument Sans',system-ui`, color: C.gold, textDecoration: 'none' }}>
            {m.source === 'youtube' ? 'المصدر · Watch on YouTube ↗' : 'المصدر · View on Facebook ↗'}
          </a>
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function NewsPage() {
  const [media,   setMedia]   = useState<Media[]>([])
  const [filter,  setFilter]  = useState<'all' | 'photo' | 'video'>('all')
  const [loading, setLoading] = useState(true)
  const [done,    setDone]    = useState(false)
  const [open,    setOpen]    = useState<Media | null>(null)

  const load = useCallback(async (type: typeof filter, offset: number) => {
    setLoading(true)
    const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (type !== 'all') q.set('type', type)
    try {
      const res  = await fetch(`/api/syrgaca-media?${q}`)
      const json = await res.json()
      const rows: Media[] = json.media ?? []
      setMedia((prev) => (offset === 0 ? rows : [...prev, ...rows]))
      setDone(rows.length < PAGE_SIZE)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { setDone(false); load(filter, 0) }, [filter, load])

  const TABS: { key: typeof filter; label: string }[] = [
    { key: 'all',   label: 'All'    },
    { key: 'photo', label: 'Photos' },
    { key: 'video', label: 'Videos' },
  ]

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <NavBar />
      <style>{`
        .nw-grid { display: grid; gap: 16px; grid-template-columns: repeat(4, 1fr); }
        .nw-wrap { padding: 26px 40px 60px; max-width: 1400px; margin: 0 auto; }
        @media (max-width: 1100px) { .nw-grid { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 767px)  {
          .nw-grid { grid-template-columns: repeat(2, 1fr); gap: 11px; }
          .nw-wrap { padding: 18px 12px 48px; }
        }
      `}</style>

      <div className="nw-wrap">
        <h1 style={{ font: `700 25px/1.2 'Instrument Sans',system-ui`, color: C.ink, margin: 0, letterSpacing: '-.02em' }}>
          Aviation Authority Updates
        </h1>
        <p style={{ font: `500 13px/1.6 ${AR_FONT}`, color: C.muted, margin: '7px 0 0', maxWidth: 620 }}>
          Photos and videos published by the Syrian General Authority of Civil Aviation —{' '}
          <a href="https://www.facebook.com/SyrGACA" target="_blank" rel="noopener noreferrer"
            style={{ color: C.forest, fontWeight: 600, textDecoration: 'none' }}>
            Facebook ↗
          </a>{' · '}
          <a href="https://www.youtube.com/@SyGACA" target="_blank" rel="noopener noreferrer"
            style={{ color: C.forest, fontWeight: 600, textDecoration: 'none' }}>
            YouTube ↗
          </a>
        </p>

        <div style={{ display: 'flex', gap: 6, margin: '18px 0 20px' }}>
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setFilter(t.key)} style={{
              padding: '8px 15px', borderRadius: 9, cursor: 'pointer',
              border: `1px solid ${filter === t.key ? C.forest : C.border}`,
              background: filter === t.key ? C.forest : C.surface,
              color: filter === t.key ? '#EDEBE0' : C.secondary,
              font: `600 12.5px/1 'Instrument Sans',system-ui`,
            }}>
              {t.label}
            </button>
          ))}
        </div>

        {media.length === 0 && !loading ? (
          <p style={{ font: `500 13px/1.6 ${AR_FONT}`, color: C.muted }}>
            No media yet — the next sync will populate this page.
          </p>
        ) : (
          <div className="nw-grid">
            {media.map((m) => <Card key={m.media_id} m={m} onOpen={setOpen} />)}
          </div>
        )}

        {loading && (
          <p style={{ font: `500 12.5px/1 'Instrument Sans',system-ui`, color: C.muted, marginTop: 22 }}>Loading…</p>
        )}

        {!loading && !done && media.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 26 }}>
            <button onClick={() => load(filter, media.length)} style={{
              padding: '11px 26px', borderRadius: 10, cursor: 'pointer',
              border: `1px solid ${C.border}`, background: C.surface, color: C.forest,
              font: `600 13px/1 'Instrument Sans',system-ui`,
            }}>
              Load more
            </button>
          </div>
        )}
      </div>

      {open && <Lightbox m={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

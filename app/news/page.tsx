'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import SiteNav from '@/components/SiteNav'
import { useT, useLocale } from '@/components/LocaleProvider'
import { dateLocaleOf, type Locale } from '@/lib/i18n'

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
  source:     'facebook' | 'youtube' | 'curated'
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

// Dates in the reader's own calendar vocabulary — the rule itself lives in dateLocaleOf, which
// the board now shares. It was this file's local knowledge, which is why the board never had it.
function fmtDate(iso: string | null, locale: Locale) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(dateLocaleOf(locale), {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Damascus',
  })
}

// ── Nav bar ───────────────────────────────────────────────────────────────────


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
  const t      = useT()
  const locale = useLocale()
  // The caption's direction follows the caption, not the page: a SyrGACA post is Arabic even
  // when the reader is on the English site, and vice versa for an airline's English clip.
  const rtl = !!m.caption && isArabic(m.caption)

  const body = (
    <>
      <div style={{ position: 'relative', aspectRatio: '4 / 3', background: C.sunken, overflow: 'hidden' }}>
        <img
          src={m.thumb_url}
          alt={m.caption?.slice(0, 120) ?? t('news.media_alt')}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        {m.media_type === 'video' && <PlayBadge />}
      </div>
      <div style={{ padding: '11px 12px 12px' }}>
        {m.caption && (
          <p dir={rtl ? 'rtl' : 'ltr'} style={{
            margin: 0, font: `500 13px/1.55 ${AR_FONT}`, color: C.secondary,
            textAlign: 'start',
            display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {m.caption}
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
          <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10.5, color: C.muted, letterSpacing: '.04em' }}>
            {fmtDate(m.posted_at, locale)}
          </span>
          <span style={{ flex: 1 }} />
          {/* No letter-spacing in Arabic: the script joins, and spacing it breaks the joins. */}
          <span style={{ font: `600 10.5px/1 'Instrument Sans',system-ui`, color: C.gold, letterSpacing: locale === 'ar' ? 'normal' : '.06em' }}>
            {t(m.media_type === 'video' ? 'news.video' : 'news.photo')}
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
  const t      = useT()
  const locale = useLocale()
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
              title={m.caption ?? t('news.video_alt')}
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
            textAlign: 'start', whiteSpace: 'pre-wrap',
          }}>
            {m.caption}
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: '#9A9588' }}>
            {fmtDate(m.posted_at, locale)}
          </span>
          {/* Attribution back to the authority's own post. */}
          <a href={m.permalink} target="_blank" rel="noopener noreferrer"
            style={{ font: `600 12px/1 'Instrument Sans',system-ui`, color: C.gold, textDecoration: 'none' }}>
            {`${t('news.source')} ↗`}
          </a>
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function NewsPage() {
  const t = useT()
  const [media,   setMedia]   = useState<Media[]>([])
  // Videos lead the gallery, so the page opens on them rather than the mixed feed.
  const [filter,  setFilter]  = useState<'all' | 'photo' | 'video'>('video')
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
    { key: 'video', label: 'news.tab_videos' },
    { key: 'photo', label: 'news.tab_photos' },
    { key: 'all',   label: 'news.tab_all'    },
  ]

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <SiteNav active="News" />
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img
            src="/av-authority.jpg"
            alt={t('news.authority')}
            width={44}
            height={44}
            style={{ width: 44, height: 44, borderRadius: 10, flexShrink: 0, objectFit: 'cover' }}
          />
          <h1 style={{ font: `700 25px/1.2 'Instrument Sans',system-ui`, color: C.ink, margin: 0, letterSpacing: '-.02em' }}>
            {t('news.title')}
          </h1>
        </div>
        <p style={{ font: `500 13px/1.6 ${AR_FONT}`, color: C.muted, margin: '7px 0 0', maxWidth: 620 }}>
          {t('news.blurb')}
        </p>

        <div style={{ display: 'flex', gap: 6, margin: '18px 0 20px' }}>
          {TABS.map((tab) => (
            <button key={tab.key} onClick={() => setFilter(tab.key)} style={{
              padding: '8px 15px', borderRadius: 9, cursor: 'pointer',
              border: `1px solid ${filter === tab.key ? C.forest : C.border}`,
              background: filter === tab.key ? C.forest : C.surface,
              color: filter === tab.key ? '#EDEBE0' : C.secondary,
              font: `600 12.5px/1 'Instrument Sans',system-ui`,
            }}>
              {t(tab.label)}
            </button>
          ))}
        </div>

        {media.length === 0 && !loading ? (
          <p style={{ font: `500 13px/1.6 ${AR_FONT}`, color: C.muted }}>
            {t('news.empty')}
          </p>
        ) : (
          <div className="nw-grid">
            {media.map((m) => <Card key={m.media_id} m={m} onOpen={setOpen} />)}
          </div>
        )}

        {loading && (
          <p style={{ font: `500 12.5px/1 'Instrument Sans',system-ui`, color: C.muted, marginTop: 22 }}>{t('label.loading')}</p>
        )}

        {!loading && !done && media.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 26 }}>
            <button onClick={() => load(filter, media.length)} style={{
              padding: '11px 26px', borderRadius: 10, cursor: 'pointer',
              border: `1px solid ${C.border}`, background: C.surface, color: C.forest,
              font: `600 13px/1 'Instrument Sans',system-ui`,
            }}>
              {t('news.load_more')}
            </button>
          </div>
        )}
      </div>

      {open && <Lightbox m={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

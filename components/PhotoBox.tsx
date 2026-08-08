'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import MapBox, { PANEL } from './MapBox'
import { useT, useLocale, useHref } from '@/components/LocaleProvider'

/**
 * Rotating photo showcase for the Track map's control stack — same shell as the video box,
 * sitting directly under it.
 *
 * Images are already rehosted in our own bucket by the Facebook sync, so these are plain
 * <img> swaps with no third-party player involved.
 *
 * Framed like the video rather than like a card: `bare`, so the picture reaches the panel's
 * own edges, with the controls on the image instead of in a header above it. The header used
 * to carry a title, a counter and three buttons stacked at one end — a second title bar over
 * something the caption already names, and a row of chevrons that gave no clue which side of
 * the picture they moved it towards.
 */

const MAX_PHOTOS  = 30
const INTERVAL_MS  = 6_000

// Arabic-capable stack — deliberately no Cairo.
const AR_FONT = "'Instrument Sans','Segoe UI',Tahoma,Arial,sans-serif"

const isArabic = (s: string) => /[؀-ۿ]/.test(s)

type Photo = {
  media_id:  string
  caption:   string | null
  permalink: string
  image_url: string | null
  thumb_url: string
}

/** Same overlay button as the video box's mute and expand controls. */
const overlayBtn: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 8,
  border: '1px solid rgba(255,255,255,.25)', background: 'rgba(0,0,0,.55)',
  backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
  color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0, padding: 0,
}

const PhotoIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={PANEL.forest} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2"/>
    <circle cx="8.5" cy="9.5" r="1.6"/>
    <path d="m3 17 5-4.5 4 3.5 3.5-3L21 17"/>
  </svg>
)

const Chevron = ({ back }: { back: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d={back ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'}/>
  </svg>
)

export default function PhotoBox({ open: openProp, onToggle, externalTrigger }: { open?: boolean; onToggle?: (next: boolean) => void; externalTrigger?: boolean } = {}) {
  const t      = useT()
  const href   = useHref()
  const locale = useLocale()
  const [photos, setPhotos] = useState<Photo[]>([])
  const [idx,    setIdx]    = useState(0)
  const [open,   setOpen]   = useState(false)
  const [paused, setPaused] = useState(false)

  // Read inside the interval so changing it doesn't restart the timer.
  const countRef = useRef(0)
  countRef.current = photos.length

  useEffect(() => {
    let cancelled = false
    fetch(`/api/syrgaca-media?type=photo&limit=${MAX_PHOTOS}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setPhotos(j.media ?? []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!open || paused || photos.length < 2) return
    const t = setInterval(() => setIdx((i) => (i + 1) % countRef.current), INTERVAL_MS)
    return () => clearInterval(t)
  }, [open, paused, photos.length])

  const p   = photos.length ? photos[idx % photos.length] : null
  const src = p ? (p.image_url ?? p.thumb_url) : null

  // Swap only once the next image has decoded, and warm the one after it. Pointing the
  // <img> straight at a new src blanks the box for a beat, which on a 6s rotation reads
  // as a flash every time.
  const [shown, setShown] = useState<string | null>(null)
  useEffect(() => {
    if (!src) return
    let cancelled = false
    const im = new window.Image()
    im.onload = () => { if (!cancelled) setShown(src) }
    im.src = src

    const nxt = photos[(idx + 1) % photos.length]
    if (nxt) new window.Image().src = nxt.image_url ?? nxt.thumb_url

    return () => { cancelled = true }
  }, [src, idx, photos])

  if (!p || !src) return null

  const rtl = !!p.caption && isArabic(p.caption)

  const step = (delta: number) => {
    setPaused(true)
    setIdx((i) => (i + delta + photos.length) % photos.length)
  }

  return (
    <MapBox
      bare
      title={t('map.authority_photos')}
      pillLabel={t('news.tab_photos')}
      icon={<PhotoIcon />}
      onOpenChange={setOpen}
      open={openProp}
      onToggle={onToggle}
      externalTrigger={externalTrigger}
    >
      {(close) => (
        /* Hovering holds the current photo so a caption can actually be read. */
        <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
          <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: '#000' }}>
            <a href={p.permalink} target="_blank" rel="noopener noreferrer"
              title={t('news.source')} style={{ display: 'block', position: 'absolute', inset: 0 }}>
              <img
                src={shown ?? src}
                alt={p.caption?.slice(0, 120) ?? t('map.photo_alt')}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </a>

            {/* Close where the video's controls sit, in the same button. */}
            <button onClick={close} style={{ ...overlayBtn, position: 'absolute', right: 8, top: 8 }} title={t('action.close')}>✕</button>

            {/*
              One arrow against each edge, rather than both stacked in a corner: the side a
              control sits on is the only thing that says which way it moves the picture.
              Physical left and right — this steps through a stack of images, not a sentence,
              and the chevron points the way the hand goes.
            */}
            {photos.length > 1 && (
              <>
                <button onClick={() => step(-1)} title={t('action.previous')}
                  style={{ ...overlayBtn, position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }}>
                  <Chevron back />
                </button>
                <button onClick={() => step(1)} title={t('action.next')}
                  style={{ ...overlayBtn, position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)' }}>
                  <Chevron back={false} />
                </button>
              </>
            )}
          </div>

          {/* Caption under the picture, with the counter and the link to the full gallery. */}
          <div style={{ padding: '9px 11px 10px' }}>
            {p.caption && (
              <p dir={rtl ? 'rtl' : 'ltr'} style={{
                margin: 0, font: `500 11.5px/1.45 ${AR_FONT}`, color: PANEL.secondary,
                textAlign: 'start',
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}>
                {p.caption}
              </p>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: p.caption ? 7 : 0 }}>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: PANEL.muted }}>
                {idx + 1} {t('label.of')} {photos.length}
              </span>
              <span style={{ flex: 1 }} />
              <Link href={href('/news')} style={{ font: `600 10.5px/1 'Instrument Sans',system-ui`, color: PANEL.forestMid, textDecoration: 'none' }}>
                {t('action.view_all')} {locale === 'ar' ? '↖' : '↗'}
              </Link>
            </div>
          </div>
        </div>
      )}
    </MapBox>
  )
}

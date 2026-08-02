'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import MapBox, { PANEL, actionBtn } from './MapBox'

/**
 * Rotating photo showcase for the Track map's control stack — same shell and size as the
 * video box, sitting directly under it.
 *
 * Images are already rehosted in our own bucket by the Facebook sync, so these are plain
 * <img> swaps with no third-party player involved.
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

const PhotoIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={PANEL.forest} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2"/>
    <circle cx="8.5" cy="9.5" r="1.6"/>
    <path d="m3 17 5-4.5 4 3.5 3.5-3L21 17"/>
  </svg>
)

export default function PhotoBox({ open: openProp, onToggle, externalTrigger }: { open?: boolean; onToggle?: (next: boolean) => void; externalTrigger?: boolean } = {}) {
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
      title="Authority Photos"
      subtitle={
        <>
          {idx + 1} of {photos.length} · <Link href="/news" style={{ color: PANEL.forestMid, fontWeight: 600, textDecoration: 'none' }}>view all ↗</Link>
        </>
      }
      pillLabel="Photos"
      icon={<PhotoIcon />}
      onOpenChange={setOpen}
      open={openProp}
      onToggle={onToggle}
      externalTrigger={externalTrigger}
      actions={
        <>
          <button onClick={() => step(-1)} style={actionBtn} title="Previous">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6"/>
            </svg>
          </button>
          <button onClick={() => step(1)} style={actionBtn} title="Next">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m9 18 6-6-6-6"/>
            </svg>
          </button>
        </>
      }
    >
      {/* Hovering holds the current photo so a caption can actually be read. */}
      <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
        <a href={p.permalink} target="_blank" rel="noopener noreferrer"
          title="View the original post" style={{ display: 'block', textDecoration: 'none' }}>
          <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: PANEL.sunken }}>
            <img
              src={shown ?? src}
              alt={p.caption?.slice(0, 120) ?? 'Aviation Authority photo'}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </div>
        </a>

        <div style={{ padding: '8px 10px 10px', minHeight: 44 }}>
          <p dir={rtl ? 'rtl' : 'ltr'} style={{
            margin: 0, font: `500 11.5px/1.45 ${AR_FONT}`, color: PANEL.secondary,
            textAlign: rtl ? 'right' : 'left',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {p.caption ?? ''}
          </p>
        </div>
      </div>
    </MapBox>
  )
}

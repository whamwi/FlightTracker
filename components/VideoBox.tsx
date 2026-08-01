'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

/**
 * Floating showcase on the Track map that plays the Syrian Civil Aviation Authority's
 * YouTube videos back to back. Rendered inside the map's top-right control stack.
 *
 * Playback is chained entirely through the embed URL — YouTube plays the id in the path
 * and then everything in `playlist`, and `loop=1` sends it back to the start — so there
 * is no need to load the IFrame Player API just to advance between clips.
 *
 * The native player chrome is switched off with `controls=0`, because it reappeared on
 * every clip change and cluttered a box this small. YouTube has no parameter for
 * "controls, but only some", so the two we want are rebuilt here: mute/unmute drives the
 * player over postMessage (which is why `enablejsapi=1` is set), and expand calls
 * requestFullscreen on the iframe directly.
 */

const C = {
  surface: '#FFFFFF',
  forest:  '#054239',
  muted:   '#8A8578',
  ink:     '#161616',
}

// Enough for a long rotation without an unwieldy URL.
const MAX_CLIPS = 10
const ORIGIN    = 'https://www.youtube-nocookie.com'

type Video = { media_id: string; video_id: string | null; caption: string | null }

export default function VideoBox() {
  const [videos, setVideos] = useState<Video[]>([])
  const [open,   setOpen]   = useState(false)
  const [ready,  setReady]  = useState(false)
  const [pinned, setPinned] = useState(false)
  const [muted,  setMuted]  = useState(true)

  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Autoplaying video is welcome on a desktop map but intrusive on a phone, where it
  // would cover a large share of the viewport. Mobile starts collapsed to a pill.
  //
  // This tracks the media query rather than reading innerWidth once, because a one-shot
  // check at mount can land before the viewport settles at its real size. Once the user
  // has toggled the box themselves, their choice wins over the breakpoint.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const apply = () => setOpen((prev) => (pinned ? prev : mq.matches))
    apply()
    setReady(true)
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [pinned])

  useEffect(() => {
    let cancelled = false
    fetch(`/api/syrgaca-media?type=video&limit=${MAX_CLIPS}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setVideos((j.media ?? []).filter((v: Video) => v.video_id)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!ready || videos.length === 0) return null

  const ids   = videos.map((v) => v.video_id!)
  const first = ids[0]
  const rest  = ids.slice(1).join(',')

  const src =
    `${ORIGIN}/embed/${first}` +
    `?autoplay=1&mute=1&loop=1&playsinline=1&rel=0&modestbranding=1` +
    `&controls=0&disablekb=1&iv_load_policy=3&enablejsapi=1` +
    `&origin=${encodeURIComponent(window.location.origin)}` +
    (rest ? `&playlist=${rest}` : `&playlist=${first}`)

  const command = (func: string) => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args: [] }), ORIGIN,
    )
  }

  const toggleMute = () => {
    command(muted ? 'unMute' : 'mute')
    setMuted(!muted)
  }

  const toggle = (next: boolean) => { setPinned(true); setOpen(next) }

  const shell = {
    background: C.surface,
    border: '2px solid rgba(0,0,0,.2)',
    borderRadius: 6,
    boxShadow: '0 1px 5px rgba(0,0,0,.15)',
    fontFamily: "'Instrument Sans', system-ui",
    overflow: 'hidden',
  }

  const iconBtn = {
    background: 'none', border: 0, cursor: 'pointer',
    color: C.muted, padding: 0, lineHeight: 0,
  }

  if (!open) {
    return (
      <button
        onClick={() => toggle(true)}
        title="Play Aviation Authority videos"
        style={{
          ...shell, padding: '4px 8px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 11, fontWeight: 700, color: C.ink, letterSpacing: '-.01em',
          lineHeight: 1.4, whiteSpace: 'nowrap',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        Videos
      </button>
    )
  }

  return (
    // Never wider than the viewport allows, so the box still fits on a phone.
    <div style={{ ...shell, width: 'min(320px, calc(100vw - 24px))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill={C.forest}><path d="M8 5v14l11-7z"/></svg>
        <span style={{ font: `700 11.5px/1.4 'Instrument Sans',system-ui`, color: C.ink, letterSpacing: '-.01em' }}>
          Aviation Authority
        </span>
        <span style={{ flex: 1 }} />

        <button onClick={toggleMute} style={iconBtn} title={muted ? 'Unmute' : 'Mute'}>
          {muted ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 5 6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>
            </svg>
          )}
        </button>

        <button onClick={() => iframeRef.current?.requestFullscreen?.()} style={iconBtn} title="Expand">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 3H3v6M21 9V3h-6M15 21h6v-6M3 15v6h6"/>
          </svg>
        </button>

        <Link href="/news" title="Open the full gallery"
          style={{ font: `600 10px/1 'Instrument Sans',system-ui`, color: C.muted, textDecoration: 'none' }}>
          All ↗
        </Link>

        <button onClick={() => toggle(false)} style={iconBtn} title="Collapse">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18"/>
          </svg>
        </button>
      </div>

      <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: '#000' }}>
        <iframe
          ref={iframeRef}
          src={src}
          title="Syrian Civil Aviation Authority videos"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen; web-share"
          allowFullScreen
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
        />
      </div>
    </div>
  )
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import MapBox, { PANEL } from './MapBox'

/**
 * Plays the Syrian Civil Aviation Authority's YouTube videos back to back in the Track
 * map's control stack.
 *
 * Playback goes through the IFrame Player API rather than the embed URL's `playlist`
 * parameter. That parameter is unreliable past a handful of ids — it was cycling only
 * four or five of them — whereas loadPlaylist() takes the full array and setLoop() wraps
 * it properly.
 *
 * Native chrome stays off (controls: 0), because it reappeared on every clip change and
 * cluttered a box this small. The two controls worth keeping are rebuilt here: volume
 * drives the player directly, and expand calls requestFullscreen on its iframe.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    YT?: any
    onYouTubeIframeAPIReady?: () => void
  }
}

// The rotation plays everything in the library. There was a 30-clip cap, and ordering the
// whole table by date under it dropped every curated entry: the channel alone had 31 videos,
// all newer than most hand-picked airline uploads, so the deliberately chosen ones fell past
// the cap and never played. Curated clips are still pulled separately and interleaved rather
// than merged by date, so they appear early instead of wherever their upload date lands.
const FEED_LIMIT = 100 // the read endpoint's own ceiling
const SCRIPT_ID  = 'yt-iframe-api'

// posted_at is used to order the rotation newest-first; the API always returns it.
type Video = { media_id: string; video_id: string | null; posted_at: string | null }

// Resolves once the API is usable. Chains onto any existing callback so several boxes
// loading at once can't clobber each other's handler.
function loadYouTubeApi(): Promise<any> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  return new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT) }
    if (!document.getElementById(SCRIPT_ID)) {
      const s = document.createElement('script')
      s.id  = SCRIPT_ID
      s.src = 'https://www.youtube.com/iframe_api'
      document.head.appendChild(s)
    }
  })
}

// Legible over any frame of video: translucent black rather than the panel's beige, which
// disappeared against bright shots.
const overlayBtn: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 8,
  border: '1px solid rgba(255,255,255,.25)', background: 'rgba(0,0,0,.55)',
  backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
  color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0, padding: 0,
}

const PlayIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill={PANEL.forest}><path d="M8 5v14l11-7z"/></svg>
)

export default function VideoBox({ open: openProp, onToggle, externalTrigger }: { open?: boolean; onToggle?: (next: boolean) => void; externalTrigger?: boolean } = {}) {
  const [videos, setVideos] = useState<Video[]>([])
  const [muted,  setMuted]  = useState(true)
  const [open,   setOpen]   = useState(false)

  const hostRef   = useRef<HTMLDivElement>(null)
  const playerRef = useRef<any>(null)

  useEffect(() => {
    let cancelled = false
    const get = (qs: string) =>
      fetch(`/api/syrgaca-media?type=video&${qs}`)
        .then((r) => r.json())
        .then((j) => ((j.media ?? []) as Video[]).filter((v) => v.video_id))
        .catch(() => [] as Video[])

    /**
     * Newest first, pinned or not.
     *
     * The feed sorts pinned items above everything else, which is right for the gallery — a
     * pin is an editorial choice about what to show. It is wrong for a rotation whose job is
     * to lead with the latest: one pinned clip from June was opening the reel while the
     * newest video sat behind it, so the authority's most recent post was the one nobody saw.
     *
     * Sorted here rather than by asking the API for a different order, so the gallery keeps
     * its pinning and only the reel changes.
     */
    const newestFirst = (list: Video[]) =>
      [...list].sort((a, b) =>
        Date.parse(b.posted_at ?? '') - Date.parse(a.posted_at ?? '') || 0)

    Promise.all([get(`source=curated&limit=${FEED_LIMIT}`), get(`limit=${FEED_LIMIT}`)])
      .then(([curatedRaw, allRaw]) => {
        if (cancelled) return
        const curated = newestFirst(curatedRaw)
        const all     = newestFirst(allRaw)
        // Interleave rather than concatenate: a curated clip every third slot, so the mix
        // shows up early instead of after a dozen channel videos nobody waits through.
        const seen = new Set(curated.map((v) => v.video_id))
        const rest = all.filter((v) => !seen.has(v.video_id))
        const out: Video[] = []
        let ci = 0, ri = 0
        while (ci < curated.length || ri < rest.length) {
          if (out.length % 3 === 2 && ci < curated.length) out.push(curated[ci++])
          else if (ri < rest.length) out.push(rest[ri++])
          else if (ci < curated.length) out.push(curated[ci++])
        }
        setVideos(out)
      })
    return () => { cancelled = true }
  }, [])

  const ids    = videos.map((v) => v.video_id!)
  const idsKey = ids.join(',')

  useEffect(() => {
    if (!open || !idsKey) return
    let cancelled = false
    let player: any

    loadYouTubeApi().then((YT) => {
      if (cancelled || !hostRef.current) return
      player = new YT.Player(hostRef.current, {
        host: 'https://www.youtube-nocookie.com',
        playerVars: {
          autoplay: 1, mute: 1, controls: 0, rel: 0,
          playsinline: 1, modestbranding: 1, disablekb: 1, iv_load_policy: 3,
        },
        events: {
          onReady: (e: any) => {
            e.target.loadPlaylist({ playlist: idsKey.split(','), index: 0 })
            e.target.setLoop(true)
            e.target.mute()
            e.target.playVideo()
          },
        },
      })
      playerRef.current = player
    })

    return () => {
      cancelled = true
      try { player?.destroy() } catch { /* already gone */ }
      playerRef.current = null
    }
  }, [open, idsKey])

  const toggleMute = useCallback(() => {
    const p = playerRef.current
    if (!p) return
    if (muted) p.unMute?.() ; else p.mute?.()
    setMuted((m) => !m)
  }, [muted])

  // iOS Safari exposes no Element.requestFullscreen — only video elements can go fullscreen
  // there, and a YouTube embed is an iframe — so the button silently did nothing on a large
  // share of phones. It is hidden where the API is absent rather than left as dead chrome.
  const [canExpand, setCanExpand] = useState(false)
  useEffect(() => {
    const el = document.createElement('div') as HTMLElement & { webkitRequestFullscreen?: unknown }
    setCanExpand(!!(el.requestFullscreen || el.webkitRequestFullscreen))
  }, [])

  const expand = useCallback(() => {
    const frame = playerRef.current?.getIframe?.() as (HTMLIFrameElement & { webkitRequestFullscreen?: () => void }) | undefined
    if (!frame) return
    if (frame.requestFullscreen) frame.requestFullscreen().catch(() => {})
    else frame.webkitRequestFullscreen?.()
  }, [])

  if (videos.length === 0) return null

  return (
    <MapBox
      bare
      title="Aviation Authority"
      pillLabel="Videos"
      icon={<PlayIcon />}
      onOpenChange={setOpen}
      open={openProp}
      onToggle={onToggle}
      externalTrigger={externalTrigger}
    >
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: '#000' }}>
        {/* The API replaces this node with its own iframe. */}
        <div ref={hostRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />

        {/* Controls sit on the picture rather than in a header above it. Bottom-right, over
            the darkest part of most shots, and small enough not to fight the video. */}
        <div style={{ position: 'absolute', right: 8, bottom: 8, display: 'flex', gap: 6 }}>
          <button onClick={toggleMute} style={overlayBtn} title={muted ? 'Unmute' : 'Mute'}>
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
          {canExpand && (
            <button onClick={expand} style={overlayBtn} title="Expand">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 3H3v6M21 9V3h-6M15 21h6v-6M3 15v6h6"/>
              </svg>
            </button>
          )}
        </div>
      </div>
    </MapBox>
  )
}

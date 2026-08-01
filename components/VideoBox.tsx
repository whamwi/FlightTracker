'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import MapBox, { BOX, iconBtn } from './MapBox'

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

const MAX_CLIPS  = 30
const SCRIPT_ID  = 'yt-iframe-api'

type Video = { media_id: string; video_id: string | null }

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

const PlayIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill={BOX.forest}><path d="M8 5v14l11-7z"/></svg>
)

export default function VideoBox() {
  const [videos, setVideos] = useState<Video[]>([])
  const [muted,  setMuted]  = useState(true)
  const [open,   setOpen]   = useState(false)

  const hostRef   = useRef<HTMLDivElement>(null)
  const playerRef = useRef<any>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/syrgaca-media?type=video&limit=${MAX_CLIPS}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setVideos((j.media ?? []).filter((v: Video) => v.video_id)) })
      .catch(() => {})
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

  const expand = useCallback(() => {
    playerRef.current?.getIframe?.()?.requestFullscreen?.()
  }, [])

  if (videos.length === 0) return null

  return (
    <MapBox
      title="Aviation Authority"
      pillLabel="Videos"
      icon={<PlayIcon />}
      onOpenChange={setOpen}
      actions={
        <>
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
          <button onClick={expand} style={iconBtn} title="Expand">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 3H3v6M21 9V3h-6M15 21h6v-6M3 15v6h6"/>
            </svg>
          </button>
        </>
      }
    >
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: '#000' }}>
        {/* The API replaces this node with its own iframe. */}
        <div ref={hostRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      </div>
    </MapBox>
  )
}

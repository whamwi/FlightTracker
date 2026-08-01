'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'

/**
 * Shared chrome for the floating boxes in the Track map's top-right control stack.
 * Keeps the video and photo boxes identical in size and behaviour.
 */

export const BOX = {
  surface: '#FFFFFF',
  forest:  '#054239',
  muted:   '#8A8578',
  ink:     '#161616',
}

export const shell = {
  background: BOX.surface,
  border: '2px solid rgba(0,0,0,.2)',
  borderRadius: 6,
  boxShadow: '0 1px 5px rgba(0,0,0,.15)',
  fontFamily: "'Instrument Sans', system-ui",
  overflow: 'hidden',
} as const

export const iconBtn = {
  background: 'none', border: 0, cursor: 'pointer',
  color: BOX.muted, padding: 0, lineHeight: 0,
} as const

export default function MapBox({
  title, pillLabel, icon, actions, children, onOpenChange,
}: {
  title:     string
  pillLabel: string
  icon:      ReactNode
  actions?:  ReactNode
  children:  ReactNode
  onOpenChange?: (open: boolean) => void
}) {
  const [open,   setOpen]   = useState(false)
  const [ready,  setReady]  = useState(false)
  const [pinned, setPinned] = useState(false)

  // Autoplaying media is welcome on a desktop map but intrusive on a phone, where it
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

  useEffect(() => { onOpenChange?.(open) }, [open, onOpenChange])

  if (!ready) return null

  const toggle = (next: boolean) => { setPinned(true); setOpen(next) }

  if (!open) {
    return (
      <button
        onClick={() => toggle(true)}
        title={title}
        style={{
          ...shell, padding: '4px 8px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 11, fontWeight: 700, color: BOX.ink, letterSpacing: '-.01em',
          lineHeight: 1.4, whiteSpace: 'nowrap',
        }}
      >
        {icon}
        {pillLabel}
      </button>
    )
  }

  return (
    // Never wider than the viewport allows, so the box still fits on a phone.
    <div style={{ ...shell, width: 'min(320px, calc(100vw - 24px))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }}>
        {icon}
        <span style={{ font: `700 11.5px/1.4 'Instrument Sans',system-ui`, color: BOX.ink, letterSpacing: '-.01em' }}>
          {title}
        </span>
        <span style={{ flex: 1 }} />
        {actions}
        <Link href="/news" title="Open the full gallery"
          style={{ font: `600 10px/1 'Instrument Sans',system-ui`, color: BOX.muted, textDecoration: 'none' }}>
          All ↗
        </Link>
        <button onClick={() => toggle(false)} style={iconBtn} title="Collapse">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18"/>
          </svg>
        </button>
      </div>
      {children}
    </div>
  )
}

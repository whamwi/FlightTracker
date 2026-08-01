'use client'

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

/**
 * Shared chrome for the floating boxes in the Track map's control stack.
 *
 * Deliberately mirrors the InAirPanel on the left of the map — same translucent panel,
 * radius, shadow, dot-and-subtitle header and 28px square buttons — so the two sides of
 * the map read as one interface rather than two.
 */

export const PANEL = {
  bg:        'rgba(237,235,224,0.97)',
  surface:   '#FFFFFF',
  border:    '#D8D3BF',
  ink:       '#161616',
  muted:     '#8A8578',
  secondary: '#3D3A3B',
  forest:    '#054239',
  forestMid: '#428177',
  sunken:    '#F7F5EC',
}

const panelShell: CSSProperties = {
  background: PANEL.bg,
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  border: `1px solid ${PANEL.border}`,
  borderRadius: 16,
  boxShadow: '0 4px 28px rgba(0,0,0,.13)',
  fontFamily: "'Instrument Sans', system-ui",
  overflow: 'hidden',
}

/** Matches the panel's close button, so header actions sit in the same visual family. */
export const actionBtn: CSSProperties = {
  width: 28, height: 28, borderRadius: 8,
  border: `1px solid ${PANEL.border}`, background: PANEL.sunken,
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0, color: PANEL.muted, fontSize: 13, lineHeight: 1, padding: 0,
}

export default function MapBox({
  title, subtitle, pillLabel, icon, actions, children, onOpenChange,
}: {
  title:     string
  subtitle?: ReactNode
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
          ...panelShell, borderRadius: 12, padding: '9px 13px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 7,
          font: `700 12px/1 'Instrument Sans',system-ui`, color: PANEL.ink,
          whiteSpace: 'nowrap',
        }}
      >
        {icon}
        {pillLabel}
      </button>
    )
  }

  return (
    // Matches the InAirPanel's width so both sides of the map line up.
    <div style={{ ...panelShell, width: 'min(308px, calc(88vw - 12px))' }}>
      <div style={{
        padding: '14px 14px 11px', borderBottom: `1px solid ${PANEL.border}`,
        display: 'flex', alignItems: 'flex-start', gap: 10,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: PANEL.forestMid, display: 'block', flexShrink: 0 }} />
            <span style={{ font: `700 13.5px/1 'Instrument Sans',system-ui`, color: PANEL.ink }}>{title}</span>
          </div>
          {subtitle && (
            <span style={{ font: `500 10.5px/1.3 'Instrument Sans',system-ui`, color: PANEL.muted, marginTop: 5, display: 'block' }}>
              {subtitle}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {actions}
          <button onClick={() => toggle(false)} style={actionBtn} title="Collapse">✕</button>
        </div>
      </div>

      {/* Inner card echoes the flight cards, accent bar included. */}
      <div style={{ padding: 10 }}>
        <div style={{
          background: PANEL.surface,
          border: `1px solid ${PANEL.border}`,
          borderTop: `3px solid ${PANEL.forest}`,
          borderRadius: 12,
          overflow: 'hidden',
        }}>
          {children}
        </div>
      </div>
    </div>
  )
}

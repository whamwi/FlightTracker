'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import Wordmark from './Wordmark'

/**
 * The site header: wordmark, a tab row on desktop, a hamburger drawer on phones.
 *
 * The tab row used to render at every width. It does not fit: at 375px it measured 391px
 * wide, so News, Destinations and Airlines each scrolled the whole page sideways and clipped
 * "Flights" off the left edge. Horizontal scroll on a page that has no horizontal content is
 * always a bug, and it was worst on the majority of the traffic.
 *
 * The drawer closes on route change, on Escape, and on a click outside it. Body scroll is
 * locked while it is open so the page behind does not move under the panel.
 */

const C = {
  surface: '#FFFFFF',
  border:  '#D5DFD0',
  forest:  '#054239',
  sunken:  '#F0EEE6',
  second:  '#4b5563',
}

export const NAV_ITEMS = [
  { label: 'Flights',      href: '/board'        },
  { label: 'Track',        href: '/'             },
  { label: 'Destinations', href: '/destinations' },
  { label: 'Airlines',     href: '/airlines'     },
  { label: 'News',         href: '/news'         },
]

export default function SiteNav({ active, right }: { active: string; right?: React.ReactNode }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open])

  return (
    <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0, zIndex: 1100 }}>
      <style>{`
        .sn-bar   { display: flex; align-items: center; width: 100%; padding: 0 40px; height: 68px; gap: 14px; }
        .sn-tabs  { display: flex; align-items: center; gap: 4px; margin-left: 14px; }
        .sn-right { display: flex; margin-left: auto; align-items: center; }
        .sn-actions { display: none; }
        .sn-burger{ display: none; }
        @media (max-width: 767px) {
          .sn-bar    { padding: 0 12px; padding-top: env(safe-area-inset-top); height: calc(58px + env(safe-area-inset-top)); gap: 0; }
          .sn-tabs   { display: none; }
          .sn-right  { display: none; }
          .sn-actions{ display: flex; align-items: center; gap: 8px; margin-left: auto; margin-right: 10px; }
          .sn-burger { display: flex; }
        }
      `}</style>

      <div className="sn-bar">
        <Link href="/" style={{ textDecoration: 'none' }} aria-label="FlySyria home">
          <Wordmark />
        </Link>

        <div className="sn-tabs">
          {NAV_ITEMS.map((t) => {
            const isActive = t.label === active
            return (
              <Link key={t.label} href={t.href} style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 10,
                textDecoration: 'none', background: isActive ? C.sunken : 'transparent',
              }}>
                <span style={{ font: `${isActive ? 700 : 600} 13.5px/1 'Instrument Sans',system-ui`, color: isActive ? C.forest : C.second, whiteSpace: 'nowrap' }}>
                  {t.label}
                </span>
              </Link>
            )
          })}
        </div>

        {right && <div className="sn-right">{right}</div>}

        {/* Filled by the Track map, which portals its media buttons here on phones. Empty
            and zero-width everywhere else, so it costs nothing on the other pages. */}
        <div id="sn-page-actions" className="sn-actions" />

        <button
          className="sn-burger"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          style={{
            width: 40, height: 40, borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface,
            alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, padding: 0,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.forest} strokeWidth="2" strokeLinecap="round">
            {open
              ? <><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>
              : <><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></>}
          </svg>
        </button>
      </div>

      {open && (
        <>
          {/* Sits below the panel but above the page, so any tap outside closes the menu. */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, top: 'calc(58px + env(safe-area-inset-top))', background: 'rgba(10,14,13,.35)', zIndex: 18 }}
          />
          <nav style={{
            position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 19,
            background: C.surface, borderBottom: `1px solid ${C.border}`,
            boxShadow: '0 12px 28px -18px rgba(0,0,0,.5)',
            padding: '6px 12px 12px', display: 'flex', flexDirection: 'column', gap: 2,
          }}>
            {NAV_ITEMS.map((t) => {
              const isActive = t.label === active
              return (
                <Link key={t.label} href={t.href} onClick={() => setOpen(false)} style={{
                  display: 'flex', alignItems: 'center', padding: '13px 12px', borderRadius: 10,
                  textDecoration: 'none', background: isActive ? C.sunken : 'transparent',
                  font: `${isActive ? 700 : 600} 15px/1 'Instrument Sans',system-ui`,
                  color: isActive ? C.forest : C.second,
                }}>
                  {t.label}
                </Link>
              )
            })}
          </nav>
        </>
      )}
    </div>
  )
}

'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

const Map = dynamic(() => import('@/components/Map'), { ssr: false })

const C = {
  surface:   '#FFFFFF',
  border:    '#D5DFD0',
  ink:       '#111827',
  forest:    '#054239',
  muted:     '#6b7280',
  sunken:    '#F0EEE6',
}

const LogoPlane = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#EDEBE0" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 22h20"/>
    <path d="M6.36 17.4 4 17l-2-4 1.1-.55a2 2 0 0 1 1.8 0l.7.35 1.7-3.4 1.9-.95a2 2 0 0 1 1.8 0l.7.35"/>
    <path d="m14.5 12.5 2.5-5.5a2 2 0 0 1 1.5-1.1l2.9-.5a1 1 0 0 1 1.1 1.3l-1.1 3a2 2 0 0 1-1.1 1.2L6.4 17.4"/>
  </svg>
)

const NAV_TABS = [
  { label: 'Flights',      href: '/board',        active: false },
  { label: 'Track',        href: '/',             active: true  },
  { label: 'Destinations', href: '/destinations', active: false },
  { label: 'Airlines',     href: '/airlines',     active: false },
]

function HomeInner() {
  const searchParams = useSearchParams()
  const flight = searchParams.get('flight') ?? undefined
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <style>{`
        .map-mobile-nav { display: flex; align-items: center; padding: 0 16px; gap: 12px; height: 56px; background: ${C.surface}; border-bottom: 1px solid ${C.border}; flex-shrink: 0; }
        .map-mobile-tabs { display: flex; overflow-x: auto; scrollbar-width: none; flex: 1; }
        .map-mobile-tabs::-webkit-scrollbar { display: none; }
        .map-desktop-nav { display: none; }
        @media (min-width: 768px) {
          .map-mobile-nav { display: none; }
          .map-desktop-nav { display: flex; }
        }
      `}</style>

      {/* Mobile nav bar */}
      <nav className="map-mobile-nav">
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexShrink: 0 }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: C.forest, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <LogoPlane />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ font: `700 16px/1 'Instrument Sans', system-ui`, color: C.ink, letterSpacing: '-.01em', whiteSpace: 'nowrap' }}>FlySyria Tracker</span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.muted, letterSpacing: '.1em' }}>DAM · ALP</span>
          </div>
        </div>
        <div className="map-mobile-tabs">
          {NAV_TABS.map(t => (
            <Link key={t.label} href={t.href} style={{
              display: 'flex', alignItems: 'center', padding: '9px 14px',
              whiteSpace: 'nowrap', textDecoration: 'none', borderRadius: 10,
              font: `${t.active ? 700 : 600} 13.5px/1 'Instrument Sans', system-ui`,
              color: t.active ? C.forest : C.muted,
              background: t.active ? C.sunken : 'transparent',
            }}>
              {t.label}
            </Link>
          ))}
        </div>
      </nav>

      {/* Map */}
      <main style={{ flex: 1, position: 'relative' }}>
        <Map targetFlight={flight} />
        {/* Desktop-only nav buttons */}
        <div className="map-desktop-nav" style={{ position: 'absolute', top: 12, right: 16, zIndex: 1000, gap: 8 }}>
          <Link
            href="/destinations"
            className="bg-blue-600/90 backdrop-blur text-white text-sm
              px-3 py-1.5 rounded-full border border-blue-500 hover:bg-blue-500 transition-colors"
          >
            Destinations →
          </Link>
          <Link
            href="/board"
            className="bg-gray-900/90 backdrop-blur text-gray-200 text-sm
              px-3 py-1.5 rounded-full border border-gray-700 hover:bg-gray-700 transition-colors"
          >
            Board →
          </Link>
        </div>
      </main>
    </div>
  )
}

export default function Home() {
  return (
    <Suspense>
      <HomeInner />
    </Suspense>
  )
}

import { ImageResponse } from 'next/og'

export const runtime     = 'edge'
export const size        = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%',
          background: '#0c1018',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Grid lines */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'linear-gradient(rgba(79,142,247,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(79,142,247,.06) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
          display: 'flex',
        }} />

        {/* Glow */}
        <div style={{
          position: 'absolute',
          top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 600, height: 300,
          background: 'radial-gradient(ellipse, rgba(79,142,247,.18) 0%, transparent 70%)',
          display: 'flex',
        }} />

        {/* Plane icon */}
        <div style={{
          width: 72, height: 72,
          background: 'rgba(79,142,247,.15)',
          borderRadius: '50%',
          border: '1.5px solid rgba(79,142,247,.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 28,
        }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
            <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"
              fill="#4f8ef7" />
          </svg>
        </div>

        {/* Wordmark */}
        <div style={{
          fontSize: 62, fontWeight: 800,
          color: '#e2e8f0',
          letterSpacing: '-2px',
          lineHeight: 1,
          marginBottom: 16,
          display: 'flex',
        }}>
          Fly<span style={{ color: '#4f8ef7' }}>Syria</span>
        </div>

        {/* Tagline */}
        <div style={{
          fontSize: 22,
          color: '#8896b0',
          letterSpacing: '0.04em',
          marginBottom: 40,
          display: 'flex',
        }}>
          Live flight tracking · DAM · ALP · LTK
        </div>

        {/* Airport pills */}
        <div style={{ display: 'flex', gap: 12 }}>
          {['Damascus', 'Aleppo', 'Lattakia'].map(name => (
            <div key={name} style={{
              padding: '8px 20px',
              background: 'rgba(79,142,247,.10)',
              border: '1px solid rgba(79,142,247,.25)',
              borderRadius: 99,
              fontSize: 16,
              color: '#8896b0',
              display: 'flex',
            }}>{name}</div>
          ))}
        </div>

        {/* Bottom URL */}
        <div style={{
          position: 'absolute', bottom: 32,
          fontSize: 15, color: '#3d4a62',
          display: 'flex',
          letterSpacing: '.04em',
        }}>
          flysyria.app
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}

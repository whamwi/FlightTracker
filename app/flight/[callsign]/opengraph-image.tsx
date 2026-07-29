import { ImageResponse } from 'next/og'

export const runtime     = 'edge'
export const size        = { width: 1200, height: 630 }
export const contentType = 'image/png'

const AIRPORT_NAMES: Record<string, string> = {
  DAM: 'Damascus', ALP: 'Aleppo', LTK: 'Lattakia',
  IST: 'Istanbul', AMM: 'Amman', DXB: 'Dubai',
  SHJ: 'Sharjah', AUH: 'Abu Dhabi', DOH: 'Doha',
  KWI: 'Kuwait', RUH: 'Riyadh', JED: 'Jeddah',
  DMM: 'Dammam', BGW: 'Baghdad', EBL: 'Erbil',
  MCT: 'Muscat', BEY: 'Beirut', CAI: 'Cairo',
  SAW: 'Istanbul', NJF: 'Najaf', OTP: 'Bucharest',
}

function statusColor(s: string): { bg: string; text: string; border: string } {
  const t = s.toLowerCase()
  if (t.includes('arrived') || t.includes('landed'))
    return { bg: 'rgba(30,58,95,.8)', text: '#60a5fa', border: 'rgba(96,165,250,.3)' }
  if (t.includes('en route') || t.includes('in flight') || t.includes('approach'))
    return { bg: 'rgba(20,83,45,.8)', text: '#4ade80', border: 'rgba(74,222,128,.3)' }
  if (t.includes('departed') || t.includes('took off'))
    return { bg: 'rgba(30,58,95,.6)', text: '#93c5fd', border: 'rgba(147,197,253,.25)' }
  if (t.includes('delayed'))
    return { bg: 'rgba(120,53,15,.8)', text: '#fbbf24', border: 'rgba(251,191,36,.3)' }
  if (t.includes('cancel'))
    return { bg: 'rgba(127,29,29,.8)', text: '#f87171', border: 'rgba(248,113,113,.3)' }
  return { bg: 'rgba(28,25,23,.8)', text: '#a8a29e', border: 'rgba(168,162,158,.2)' }
}

function prettyNum(raw: string): string {
  const m = raw.match(/^([A-Z]{2,3})(\d+.*)$/)
  return m ? `${m[1]} ${m[2]}` : raw
}

export default async function Image(
  { params }: { params: Promise<{ callsign: string }> }
) {
  const { callsign } = await params
  const num = callsign.replace(/\s+/g, '').toUpperCase()

  let flight: Record<string, string | null> | null = null
  try {
    const res = await fetch(`https://www.flysyria.app/api/flight?num=${encodeURIComponent(num)}`, {
      next: { revalidate: 60 },
    })
    if (res.ok) {
      const data = await res.json()
      flight = data?.flight ?? null
    }
  } catch { /* fall through to generic */ }

  const pretty   = prettyNum(num)
  const dep      = flight?.dep_iata ?? ''
  const arr      = flight?.arr_iata ?? ''
  const depName  = AIRPORT_NAMES[dep] ?? dep
  const arrName  = AIRPORT_NAMES[arr] ?? arr
  const airline  = flight?.airline_name ?? ''
  const status   = flight?.status ?? 'Scheduled'
  const ac       = flight?.aircraft_type ?? ''
  const reg      = flight?.aircraft_reg ?? ''
  const sc       = statusColor(status)

  return new ImageResponse(
    (
      <div style={{
        width: '100%', height: '100%',
        background: '#0c1018',
        display: 'flex', flexDirection: 'column',
        fontFamily: 'system-ui, sans-serif',
        position: 'relative', overflow: 'hidden',
      }}>
        {/* Grid */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'linear-gradient(rgba(79,142,247,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(79,142,247,.05) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
          display: 'flex',
        }} />

        {/* Glow behind route */}
        <div style={{
          position: 'absolute',
          top: '40%', left: '50%',
          width: 700, height: 320,
          background: 'radial-gradient(ellipse, rgba(79,142,247,.12) 0%, transparent 68%)',
          display: 'flex',
        }} />

        {/* Top bar */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '36px 56px 0',
        }}>
          {/* FlySyria brand */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              background: 'rgba(79,142,247,.15)',
              border: '1px solid rgba(79,142,247,.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="#4f8ef7" />
              </svg>
            </div>
            <span style={{ fontSize: 22, fontWeight: 700, color: '#e2e8f0', letterSpacing: '-0.5px', display: 'flex' }}>
              Fly<span style={{ color: '#4f8ef7' }}>Syria</span>
            </span>
          </div>

          {/* Status badge */}
          <div style={{
            padding: '8px 20px',
            background: sc.bg,
            border: `1px solid ${sc.border}`,
            borderRadius: 99,
            fontSize: 18, fontWeight: 600,
            color: sc.text,
            display: 'flex',
          }}>
            {status}
          </div>
        </div>

        {/* Main content */}
        <div style={{
          flex: 1,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '0 56px',
        }}>
          {/* Flight number */}
          <div style={{
            fontSize: 86, fontWeight: 800,
            color: '#e2e8f0',
            letterSpacing: '-3px',
            lineHeight: 1,
            marginBottom: 8,
            display: 'flex',
          }}>
            {pretty}
          </div>

          {/* Airline */}
          {airline ? (
            <div style={{
              fontSize: 24, color: '#8896b0',
              marginBottom: 48,
              display: 'flex',
            }}>
              {airline}
            </div>
          ) : null}

          {/* Route row */}
          {dep && arr ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 24,
            }}>
              {/* DEP */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ fontSize: 52, fontWeight: 800, color: '#e2e8f0', letterSpacing: '-1px', lineHeight: 1, display: 'flex' }}>{dep}</div>
                <div style={{ fontSize: 18, color: '#505d78', marginTop: 4, display: 'flex' }}>{depName}</div>
              </div>

              {/* Arrow */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                  <div style={{ width: 80, height: 1.5, background: 'rgba(79,142,247,.4)', display: 'flex' }} />
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12h14M13 6l6 6-6 6" stroke="#4f8ef7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </div>

              {/* ARR */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ fontSize: 52, fontWeight: 800, color: '#e2e8f0', letterSpacing: '-1px', lineHeight: 1, display: 'flex' }}>{arr}</div>
                <div style={{ fontSize: 18, color: '#505d78', marginTop: 4, display: 'flex' }}>{arrName}</div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Bottom strip */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 56px 36px',
        }}>
          {/* A/C + reg */}
          <div style={{ display: 'flex', gap: 16 }}>
            {ac ? (
              <div style={{
                padding: '6px 14px',
                background: 'rgba(255,255,255,.04)',
                border: '1px solid rgba(255,255,255,.08)',
                borderRadius: 6,
                fontSize: 15, color: '#505d78',
                display: 'flex',
              }}>{ac}</div>
            ) : null}
            {reg ? (
              <div style={{
                padding: '6px 14px',
                background: 'rgba(255,255,255,.04)',
                border: '1px solid rgba(255,255,255,.08)',
                borderRadius: 6,
                fontSize: 15, color: '#505d78',
                display: 'flex',
              }}>{reg}</div>
            ) : null}
          </div>

          <div style={{ fontSize: 15, color: '#2e3a52', display: 'flex', letterSpacing: '.04em' }}>
            flysyria.app
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}

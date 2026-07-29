import { ImageResponse } from 'next/og'

export const runtime     = 'edge'
export const size        = { width: 1200, height: 630 }
export const contentType = 'image/png'

const AIRPORT_NAMES: Record<string, string> = {
  DAM: 'Damascus', ALP: 'Aleppo',   LTK: 'Lattakia',
  IST: 'Istanbul', SAW: 'Istanbul', AMM: 'Amman',
  DXB: 'Dubai',    SHJ: 'Sharjah', AUH: 'Abu Dhabi',
  DOH: 'Doha',     KWI: 'Kuwait',  RUH: 'Riyadh',
  JED: 'Jeddah',   DMM: 'Dammam',  BGW: 'Baghdad',
  EBL: 'Erbil',    MCT: 'Muscat',  BEY: 'Beirut',
  CAI: 'Cairo',    NJF: 'Najaf',   OTP: 'Bucharest',
  AMS: 'Amsterdam',
}

function statusStyle(s: string): { bg: string; dot: string; text: string; border: string } {
  const t = s.toLowerCase()
  if (t.includes('arrived') || t.includes('landed'))
    return { bg: 'rgba(30,58,95,.75)', dot: '#60a5fa', text: '#93c5fd', border: 'rgba(96,165,250,.25)' }
  if (t.includes('en route') || t.includes('in flight') || t.includes('approach'))
    return { bg: 'rgba(20,83,45,.75)', dot: '#4ade80', text: '#86efac', border: 'rgba(74,222,128,.25)' }
  if (t.includes('departed') || t.includes('took off'))
    return { bg: 'rgba(30,58,95,.5)',  dot: '#93c5fd', text: '#93c5fd', border: 'rgba(147,197,253,.2)' }
  if (t.includes('delayed'))
    return { bg: 'rgba(120,53,15,.75)', dot: '#fbbf24', text: '#fcd34d', border: 'rgba(251,191,36,.25)' }
  if (t.includes('cancel'))
    return { bg: 'rgba(127,29,29,.75)', dot: '#f87171', text: '#fca5a5', border: 'rgba(248,113,113,.25)' }
  return   { bg: 'rgba(22,28,42,.8)',   dot: '#8896b0', text: '#8896b0', border: 'rgba(136,150,176,.15)' }
}

function prettyNum(raw: string): string {
  const m = raw.match(/^([A-Z]{2,3})(\d+.*)$/)
  return m ? `${m[1]} ${m[2]}` : raw
}

// UTC HH:MM → Syria local (UTC+3)
function toSyria(hhmm: string | null): string {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  const total = ((h * 60 + m) + 180) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function fmtDur(min: number | null): string {
  if (!min || min <= 0) return ''
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

export default async function Image(
  { params }: { params: Promise<{ callsign: string }> }
) {
  const { callsign } = await params
  const num = callsign.replace(/\s+/g, '').toUpperCase()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let flight: any = null
  try {
    const res = await fetch(`https://www.flysyria.app/api/flight?num=${encodeURIComponent(num)}`, {
      next: { revalidate: 60 },
    })
    if (res.ok) flight = (await res.json())?.flight ?? null
  } catch { /* generic fallback */ }

  const pretty  = prettyNum(num)
  const dep     = flight?.dep_iata ?? ''
  const arr     = flight?.arr_iata ?? ''
  const depName = AIRPORT_NAMES[dep] ?? dep
  const arrName = AIRPORT_NAMES[arr] ?? arr
  const airline = flight?.airline_name ?? ''
  const status  = flight?.status ?? 'Scheduled'
  const ac      = flight?.aircraft_type ?? ''
  const reg     = flight?.aircraft_reg ?? ''
  const depTime = toSyria(flight?.dep_time_utc ?? null)
  const arrTime = toSyria(flight?.arr_time_utc ?? null)
  const dur     = fmtDur(flight?.duration_min ?? null)
  const sc      = statusStyle(status)

  const hasRoute = dep && arr

  return new ImageResponse(
    (
      <div style={{
        width: '100%', height: '100%',
        background: '#0c1018',
        display: 'flex', flexDirection: 'column',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        position: 'relative', overflow: 'hidden',
      }}>
        {/* Grid background */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage:
            'linear-gradient(rgba(79,142,247,.045) 1px, transparent 1px),' +
            'linear-gradient(90deg, rgba(79,142,247,.045) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
          display: 'flex',
        }} />

        {/* Centre glow */}
        <div style={{
          position: 'absolute', top: '45%', left: '50%',
          width: 800, height: 360,
          background: 'radial-gradient(ellipse, rgba(79,142,247,.13) 0%, transparent 65%)',
          transform: 'translate(-50%, -50%)',
          display: 'flex',
        }} />

        {/* Blue top accent bar */}
        <div style={{ height: 4, background: 'linear-gradient(90deg, #2563eb 0%, #4f8ef7 50%, #2563eb 100%)', display: 'flex', flexShrink: 0 }} />

        {/* ── Top bar ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '28px 52px 0',
        }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{
              width: 34, height: 34, borderRadius: '50%',
              background: 'rgba(79,142,247,.15)',
              border: '1px solid rgba(79,142,247,.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginRight: 10,
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="#4f8ef7"/>
              </svg>
            </div>
            <span style={{ fontSize: 20, fontWeight: 700, color: '#d8e0ef', letterSpacing: '-0.4px', display: 'flex' }}>
              Fly<span style={{ color: '#4f8ef7' }}>Syria</span>
            </span>
          </div>

          {/* Status badge */}
          <div style={{
            display: 'flex', alignItems: 'center',
            padding: '8px 18px',
            background: sc.bg,
            border: `1px solid ${sc.border}`,
            borderRadius: 99,
          }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: sc.dot, marginRight: 8, display: 'flex', flexShrink: 0 }} />
            <span style={{ fontSize: 17, fontWeight: 600, color: sc.text, display: 'flex' }}>{status}</span>
          </div>
        </div>

        {/* ── Main ── */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '0 52px',
        }}>
          {/* Flight number */}
          <div style={{
            fontSize: 92, fontWeight: 800,
            color: '#e8edf7',
            letterSpacing: '-3.5px', lineHeight: 1,
            marginBottom: 6,
            display: 'flex',
          }}>
            {pretty}
          </div>

          {/* Airline */}
          {airline ? (
            <div style={{ fontSize: 22, color: '#6b7a96', marginBottom: 44, display: 'flex' }}>
              {airline}
            </div>
          ) : <div style={{ marginBottom: 44, display: 'flex' }} />}

          {/* Route */}
          {hasRoute && (
            <div style={{ display: 'flex', alignItems: 'flex-start', width: '100%', maxWidth: 760 }}>

              {/* DEP */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 120 }}>
                <div style={{ fontSize: 66, fontWeight: 800, color: '#e8edf7', letterSpacing: '-2px', lineHeight: 1, display: 'flex' }}>{dep}</div>
                <div style={{ fontSize: 16, color: '#404d65', marginTop: 5, display: 'flex' }}>{depName}</div>
                {depTime && <div style={{ fontSize: 22, fontWeight: 700, color: '#8896b0', marginTop: 10, display: 'flex' }}>{depTime}</div>}
              </div>

              {/* Path */}
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '22px 20px 0', position: 'relative' }}>
                {/* Left line */}
                <div style={{ flex: 1, height: 1.5, background: 'rgba(79,142,247,.25)', display: 'flex' }} />
                {/* Plane */}
                <div style={{ display: 'flex', alignItems: 'center', padding: '0 14px' }}>
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
                    <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"
                      fill="#4f8ef7" opacity="0.7" transform="rotate(90 12 12)" />
                  </svg>
                </div>
                {/* Right line */}
                <div style={{ flex: 1, height: 1.5, background: 'rgba(79,142,247,.25)', display: 'flex' }} />
              </div>

              {/* ARR */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 120 }}>
                <div style={{ fontSize: 66, fontWeight: 800, color: '#e8edf7', letterSpacing: '-2px', lineHeight: 1, display: 'flex' }}>{arr}</div>
                <div style={{ fontSize: 16, color: '#404d65', marginTop: 5, display: 'flex' }}>{arrName}</div>
                {arrTime && <div style={{ fontSize: 22, fontWeight: 700, color: '#8896b0', marginTop: 10, display: 'flex' }}>{arrTime}</div>}
              </div>
            </div>
          )}

          {/* Duration */}
          {dur && (
            <div style={{ marginTop: 18, fontSize: 13, color: '#2e3a52', letterSpacing: '.06em', display: 'flex' }}>
              {dur.toUpperCase()}
            </div>
          )}
        </div>

        {/* ── Footer strip ── */}
        <div style={{
          borderTop: '1px solid rgba(255,255,255,.055)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 52px 20px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {ac ? (
              <div style={{
                padding: '5px 13px',
                background: 'rgba(255,255,255,.04)',
                border: '1px solid rgba(255,255,255,.07)',
                borderRadius: 5,
                fontSize: 14, color: '#404d65',
                display: 'flex', marginRight: 8,
              }}>{ac}</div>
            ) : null}
            {reg ? (
              <div style={{
                padding: '5px 13px',
                background: 'rgba(255,255,255,.04)',
                border: '1px solid rgba(255,255,255,.07)',
                borderRadius: 5,
                fontSize: 14, color: '#404d65',
                display: 'flex',
              }}>{reg}</div>
            ) : null}
          </div>
          <div style={{ fontSize: 14, color: '#252e42', letterSpacing: '.05em', display: 'flex' }}>
            flysyria.app
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}

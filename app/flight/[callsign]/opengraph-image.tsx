import { ImageResponse } from 'next/og'

export const runtime     = 'edge'
export const size        = { width: 1200, height: 630 }
export const contentType = 'image/png'

// Theme — matches the FlightDetail share card
const C = {
  bg:        '#EDEBE0',
  surface:   '#FFFFFF',
  ink:       '#111827',
  mid:       '#374151',
  muted:     '#6b7280',
  border:    '#D8D3BF',
  forest:    '#054239',
  forestMid: '#556A4E',
  gold:      '#B9A779',
  blue:      '#3b82f6',
}

function statusStyle(s: string): { bg: string; text: string; dot: string } {
  const t = s.toLowerCase()
  if (t.includes('arrived') || t.includes('landed'))
    return { bg: '#dcfce7', text: '#166534', dot: '#16a34a' }
  if (t.includes('en route') || t.includes('in flight') || t.includes('approach'))
    return { bg: '#d1fae5', text: '#065f46', dot: '#10b981' }
  if (t.includes('departed') || t.includes('took off'))
    return { bg: '#dbeafe', text: '#1d4ed8', dot: '#3b82f6' }
  if (t.includes('delayed'))
    return { bg: '#fef3c7', text: '#92400e', dot: '#f59e0b' }
  if (t.includes('cancel'))
    return { bg: '#fee2e2', text: '#991b1b', dot: '#ef4444' }
  if (t.includes('expected') || t.includes('estimated'))
    return { bg: '#fef3c7', text: '#92400e', dot: '#f59e0b' }
  return   { bg: '#f1f5f9', text: '#475569', dot: '#94a3b8' }
}

function prettyNum(raw: string): string {
  const m = raw.match(/^([A-Z]{2,3})(\d+.*)$/)
  return m ? `${m[1]} ${m[2]}` : raw
}

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
        background: C.bg,
        display: 'flex', flexDirection: 'column',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        position: 'relative',
      }}>

        {/* Subtle texture — diagonal hatching via repeating gradient */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'repeating-linear-gradient(135deg, rgba(5,66,57,.03) 0px, rgba(5,66,57,.03) 1px, transparent 1px, transparent 12px)',
          display: 'flex',
        }} />

        {/* Forest green top bar */}
        <div style={{ height: 7, background: C.forest, display: 'flex', flexShrink: 0 }} />

        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '26px 52px 0',
        }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              background: C.forest,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginRight: 11,
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="white"/>
              </svg>
            </div>
            <span style={{ fontSize: 22, fontWeight: 700, color: C.forest, letterSpacing: '-0.5px', display: 'flex' }}>
              Fly<span style={{ color: C.gold }}>Syria</span>
            </span>
          </div>

          {/* Status badge */}
          <div style={{
            display: 'flex', alignItems: 'center',
            padding: '9px 20px',
            background: sc.bg,
            borderRadius: 99,
            border: `1.5px solid ${sc.dot}33`,
          }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot, marginRight: 9, display: 'flex', flexShrink: 0 }} />
            <span style={{ fontSize: 18, fontWeight: 700, color: sc.text, display: 'flex' }}>{status}</span>
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
            fontSize: 96, fontWeight: 900,
            color: C.ink,
            letterSpacing: '-4px', lineHeight: 1,
            marginBottom: 4,
            display: 'flex',
          }}>
            {pretty}
          </div>

          {/* Airline — bigger and bold */}
          {airline ? (
            <div style={{
              fontSize: 30, fontWeight: 700,
              color: C.forestMid,
              marginBottom: 44,
              letterSpacing: '-0.3px',
              display: 'flex',
            }}>
              {airline}
            </div>
          ) : <div style={{ marginBottom: 44, display: 'flex' }} />}

          {/* Route */}
          {hasRoute && (
            <div style={{
              display: 'flex', alignItems: 'center',
              width: '100%', maxWidth: 780,
              background: C.surface,
              borderRadius: 20,
              border: `1.5px solid ${C.border}`,
              padding: '28px 40px',
            }}>

              {/* DEP */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 160 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.muted, letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 6, display: 'flex' }}>DEP</div>
                <div style={{ fontSize: 72, fontWeight: 900, color: C.ink, letterSpacing: '-2.5px', lineHeight: 1, display: 'flex' }}>{dep}</div>
                {depTime && (
                  <div style={{ fontSize: 28, fontWeight: 800, color: C.forest, marginTop: 10, letterSpacing: '-0.5px', display: 'flex' }}>{depTime}</div>
                )}
              </div>

              {/* Centre — plane + line */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                  <div style={{ flex: 1, height: 1.5, background: C.border, display: 'flex' }} />
                  <div style={{
                    width: 44, height: 44, borderRadius: '50%',
                    background: C.forest,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    marginLeft: 12, marginRight: 12, flexShrink: 0,
                  }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                      <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"
                        fill="white" transform="rotate(90 12 12)" />
                    </svg>
                  </div>
                  <div style={{ flex: 1, height: 1.5, background: C.border, display: 'flex' }} />
                </div>
                {dur && (
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.muted, marginTop: 10, letterSpacing: '.06em', display: 'flex' }}>
                    {dur.toUpperCase()}
                  </div>
                )}
              </div>

              {/* ARR */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 160 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.muted, letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 6, display: 'flex' }}>ARR</div>
                <div style={{ fontSize: 72, fontWeight: 900, color: C.ink, letterSpacing: '-2.5px', lineHeight: 1, display: 'flex' }}>{arr}</div>
                {arrTime && (
                  <div style={{ fontSize: 28, fontWeight: 800, color: C.forest, marginTop: 10, letterSpacing: '-0.5px', display: 'flex' }}>{arrTime}</div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{
          borderTop: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 52px 18px',
          background: `rgba(5,66,57,.04)`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {ac ? (
              <div style={{
                padding: '5px 14px',
                background: 'rgba(5,66,57,.08)',
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                fontSize: 15, fontWeight: 600, color: C.forestMid,
                display: 'flex', marginRight: 8,
              }}>{ac}</div>
            ) : null}
            {reg ? (
              <div style={{
                padding: '5px 14px',
                background: 'rgba(5,66,57,.08)',
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                fontSize: 15, fontWeight: 600, color: C.forestMid,
                display: 'flex',
              }}>{reg}</div>
            ) : null}
          </div>
          <div style={{ fontSize: 15, color: C.gold, fontWeight: 600, letterSpacing: '.04em', display: 'flex' }}>
            flysyria.app
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}

import { ImageResponse } from 'next/og'

export const runtime     = 'edge'
export const size        = { width: 1200, height: 630 }
export const contentType = 'image/png'

const C = {
  bg:        '#EDEBE0',
  surface:   '#FFFFFF',
  ink:       '#111827',
  muted:     '#6b7280',
  border:    '#D8D3BF',
  forest:    '#054239',
  forestMid: '#556A4E',
  gold:      '#B9A779',
}

const CITY: Record<string, string> = {
  DAM: 'Damascus',  ALP: 'Aleppo',      LTK: 'Lattakia',
  IST: 'Istanbul',  SAW: 'Istanbul',    ESB: 'Ankara',
  AMM: 'Amman',     BEY: 'Beirut',      BGW: 'Baghdad',
  EBL: 'Erbil',     NJF: 'Najaf',       BSR: 'Basra',
  DXB: 'Dubai',     DWC: 'Dubai',       SHJ: 'Sharjah',
  AUH: 'Abu Dhabi', DOH: 'Doha',        KWI: 'Kuwait',
  MCT: 'Muscat',    RUH: 'Riyadh',      JED: 'Jeddah',
  DMM: 'Dammam',    MED: 'Madinah',     CAI: 'Cairo',
  SSH: 'Sharm',     ATH: 'Athens',      OTP: 'Bucharest',
  VIE: 'Vienna',    FRA: 'Frankfurt',   CDG: 'Paris',
  LHR: 'London',    AMS: 'Amsterdam',   MXP: 'Milan',
  FCO: 'Rome',      WAW: 'Warsaw',      SVO: 'Moscow',
  GYD: 'Baku',      TBS: 'Tbilisi',     EVN: 'Yerevan',
  THR: 'Tehran',    IKA: 'Tehran',
}

function cityOf(iata: string): string { return CITY[iata] ?? iata }

function cityFontSize(name: string): number {
  if (name.length <= 5) return 50
  if (name.length <= 7) return 46
  if (name.length <= 9) return 40
  if (name.length <= 11) return 34
  return 28
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
  if (t.includes('expected') || t.includes('estimated') || t.includes('boarding'))
    return { bg: '#fef3c7', text: '#92400e', dot: '#f59e0b' }
  return   { bg: '#f1f5f9', text: '#475569', dot: '#94a3b8' }
}

function prettyNum(raw: string): string {
  const m = raw.match(/^([A-Z]{2,3})(\d+.*)$/)
  return m ? `${m[1]} ${m[2]}` : raw
}

function toSyria(hhmm: string | null | undefined): string {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return ''
  const total = ((h * 60 + m) + 180) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function isoToSyria(val: string | number | null | undefined): string {
  if (!val) return ''
  const ms = typeof val === 'number' ? val * 1000 : new Date(val as string).getTime()
  if (isNaN(ms)) return ''
  const totalMin = Math.floor(ms / 60_000) % 1440
  const syria = (totalMin + 180) % 1440
  return `${String(Math.floor(syria / 60)).padStart(2, '0')}:${String(syria % 60).padStart(2, '0')}`
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
  } catch { /* fallback to generic card */ }

  const pretty  = prettyNum(num)
  const dep     = flight?.dep_iata ?? ''
  const arr     = flight?.arr_iata ?? ''
  const airline = flight?.airline_name ?? ''
  const status  = flight?.status ?? 'Scheduled'
  const ac      = flight?.aircraft_type ?? ''
  const reg     = flight?.aircraft_reg ?? ''

  // Estimated arrival when no explicit revised/actual: actual_dep + duration
  const estimatedArrUtc = flight && !flight.actual_arr_utc && !flight.revised_arr_utc && flight.actual_dep_utc && flight.duration_min > 0
    ? new Date(new Date(flight.actual_dep_utc as string).getTime() + (flight.duration_min as number) * 60_000).toISOString()
    : null

  // Best available time: actual > revised > estimated (dep+dur) > scheduled
  const depTime = isoToSyria(flight?.actual_dep_utc)
               || isoToSyria(flight?.revised_dep_utc)
               || toSyria(flight?.dep_time_utc)
  const arrTime = isoToSyria(flight?.actual_arr_utc)
               || isoToSyria(flight?.revised_arr_utc)
               || isoToSyria(estimatedArrUtc)
               || toSyria(flight?.arr_time_utc)

  const dur     = fmtDur(flight?.duration_min ?? null)
  const sc      = statusStyle(status)
  const depCity = dep ? cityOf(dep) : ''
  const arrCity = arr ? cityOf(arr) : ''
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
        {/* Diagonal texture */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'repeating-linear-gradient(135deg, rgba(5,66,57,.025) 0px, rgba(5,66,57,.025) 1px, transparent 1px, transparent 14px)',
          display: 'flex',
        }} />

        {/* Top accent bar */}
        <div style={{ height: 7, background: C.forest, display: 'flex', flexShrink: 0 }} />

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '22px 52px 0',
        }}>
          {/* Logo — actual SVG + wordmark */}
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {/* Inline globe+plane SVG from flysyria-globe-logo.svg (transparent bg) */}
            <svg width="50" height="53" viewBox="6 2 84 90" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: 10 }}>
              <circle cx="40" cy="58" r="32" stroke="#054239" strokeWidth="2.6" />
              <circle cx="40" cy="58" r="25" fill="#054239" stroke="#054239" strokeWidth="2.6" />
              <g transform="rotate(90 40 58)">
                <path d="M40 33v50M20 38c7 8 7 32 0 40M60 38c-7 8-7 32 0 40M11 58h58" stroke="#EDEBE0" strokeWidth="2.2" strokeLinecap="round" />
              </g>
              <g transform="translate(58 4) rotate(-12) scale(1.7)">
                <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" fill="#B9A779" stroke="#054239" strokeWidth="1.1" strokeLinejoin="round" strokeLinecap="round" />
              </g>
            </svg>
            {/* Wordmark: FlySyria dark green / Tracker light green */}
            <span style={{ display: 'flex', alignItems: 'baseline' }}>
              <span style={{ fontSize: 22, fontWeight: 800, color: C.forest, letterSpacing: '-.4px', display: 'flex' }}>FlySyria</span>
              <span style={{ fontSize: 22, fontWeight: 600, color: C.forestMid, letterSpacing: '-.2px', marginLeft: 6, display: 'flex' }}>Tracker</span>
            </span>
          </div>

          {/* Status badge */}
          <div style={{
            display: 'flex', alignItems: 'center',
            padding: '8px 20px',
            background: sc.bg,
            borderRadius: 99,
            border: `1.5px solid ${sc.dot}44`,
          }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot, marginRight: 8, display: 'flex', flexShrink: 0 }} />
            <span style={{ fontSize: 17, fontWeight: 700, color: sc.text, display: 'flex' }}>{status}</span>
          </div>
        </div>

        {/* Main content */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '0 52px',
        }}>
          {/* Flight number */}
          <div style={{
            fontSize: 90, fontWeight: 900, color: C.ink,
            letterSpacing: '-4px', lineHeight: 1,
            marginBottom: 2, display: 'flex',
          }}>
            {pretty}
          </div>

          {/* Airline name */}
          {airline ? (
            <div style={{
              fontSize: 28, fontWeight: 700,
              color: C.forestMid,
              marginBottom: 36, letterSpacing: '-.2px',
              display: 'flex',
            }}>
              {airline}
            </div>
          ) : <div style={{ marginBottom: 36, display: 'flex' }} />}

          {/* Route card */}
          {hasRoute && (
            <div style={{
              display: 'flex', alignItems: 'center',
              width: '100%', maxWidth: 900,
              background: C.surface,
              borderRadius: 20,
              border: `1.5px solid ${C.border}`,
              padding: '24px 44px',
            }}>
              {/* DEP */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 200 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.muted, letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 4, display: 'flex' }}>DEP</div>
                <div style={{ fontSize: cityFontSize(depCity), fontWeight: 900, color: C.ink, lineHeight: 1.05, display: 'flex' }}>{depCity}</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.muted, marginTop: 3, letterSpacing: '.04em', display: 'flex' }}>{dep}</div>
                {depTime ? (
                  <div style={{ fontSize: 30, fontWeight: 800, color: C.forest, marginTop: 8, letterSpacing: '-1px', display: 'flex' }}>{depTime}</div>
                ) : null}
              </div>

              {/* Centre: line + plane + duration */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                  <div style={{ flex: 1, height: 1.5, background: C.border, display: 'flex' }} />
                  <div style={{
                    width: 44, height: 44, borderRadius: '50%',
                    background: C.forest,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    marginLeft: 14, marginRight: 14, flexShrink: 0,
                  }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                      <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="white" transform="rotate(90 12 12)" />
                    </svg>
                  </div>
                  <div style={{ flex: 1, height: 1.5, background: C.border, display: 'flex' }} />
                </div>
                {dur ? (
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.muted, marginTop: 10, letterSpacing: '.07em', display: 'flex' }}>
                    {dur.toUpperCase()}
                  </div>
                ) : null}
              </div>

              {/* ARR */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 200 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.muted, letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 4, display: 'flex' }}>ARR</div>
                <div style={{ fontSize: cityFontSize(arrCity), fontWeight: 900, color: C.ink, lineHeight: 1.05, display: 'flex' }}>{arrCity}</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.muted, marginTop: 3, letterSpacing: '.04em', display: 'flex' }}>{arr}</div>
                {arrTime ? (
                  <div style={{ fontSize: 30, fontWeight: 800, color: C.forest, marginTop: 8, letterSpacing: '-1px', display: 'flex' }}>{arrTime}</div>
                ) : null}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          borderTop: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 52px 16px',
          background: 'rgba(5,66,57,.04)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {ac ? (
              <div style={{
                padding: '4px 13px',
                background: 'rgba(5,66,57,.08)', border: `1px solid ${C.border}`,
                borderRadius: 6, fontSize: 14, fontWeight: 600, color: C.forestMid,
                display: 'flex', marginRight: 8,
              }}>{ac}</div>
            ) : null}
            {reg ? (
              <div style={{
                padding: '4px 13px',
                background: 'rgba(5,66,57,.08)', border: `1px solid ${C.border}`,
                borderRadius: 6, fontSize: 14, fontWeight: 600, color: C.forestMid,
                display: 'flex',
              }}>{reg}</div>
            ) : null}
          </div>
          <div style={{ fontSize: 14, color: C.gold, fontWeight: 600, letterSpacing: '.04em', display: 'flex' }}>
            flysyria.app
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}

export const API_BASE = 'https://flighttracker-sy.vercel.app'

export const AIRLINE_NAMES: Record<string, string> = {
  XH: 'Flynas', FYC: 'Fly Cham', TK: 'Turkish Airlines', EY: 'Etihad Airways',
  J9: 'Jazeera Airways', FZ: 'flydubai', G9: 'Air Arabia',
  RJ: 'Royal Jordanian', RB: 'Syrian Air', QR: 'Qatar Airways',
  PC: 'Pegasus Airlines', '3L': 'Air Arabia', ME: 'Middle East Airlines',
}

const LOCAL_LOGOS: Record<string, string> = {
  XH:  'airlines/XH.jpg',
  FYC: 'airlines/FYC.jpg',
  TK:  'airlines/TK.jpg',
  EY:  'airlines/EY.png',
  J9:  'airlines/J9.png',
  FZ:  'airlines/FZ.jpg',
  G9:  'airlines/G9.png',
  '3L':'airlines/G9.png',
}
export const LOGO_WHITE_BG = new Set(['J9', 'G9', '3L'])

export function airlineLogo(iata: string): string {
  if (LOCAL_LOGOS[iata]) return `${API_BASE}/${LOCAL_LOGOS[iata]}`
  return `https://images.flightsfrom.com/airlines/100/${iata}_100px.png`
}

export const CITY: Record<string, string> = {
  DAM: 'Damascus',  ALP: 'Aleppo',    SHJ: 'Sharjah',
  DXB: 'Dubai',     AUH: 'Abu Dhabi', MCT: 'Muscat',
  IST: 'Istanbul',  SAW: 'Istanbul',  AMM: 'Amman',
  BEY: 'Beirut',    CAI: 'Cairo',     DOH: 'Doha',
  KWI: 'Kuwait City', RUH: 'Riyadh', JED: 'Jeddah',
  DMM: 'Dammam',    BGW: 'Baghdad',   EBL: 'Erbil',
  NJF: 'Najaf',     OTP: 'Bucharest', MJI: 'Tripoli',
  AMS: 'Amsterdam', MED: 'Medina',    ESB: 'Ankara',
  GYD: 'Baku',      LED: 'St. Petersburg', SVO: 'Moscow',
  TAS: 'Tashkent',  ALA: 'Almaty',    EVN: 'Yerevan',
}

export const AIRPORT_FLAG: Record<string, string> = {
  DAM: '🇸🇾', ALP: '🇸🇾',
  SHJ: '🇦🇪', DXB: '🇦🇪', AUH: '🇦🇪',
  MCT: '🇴🇲',
  IST: '🇹🇷', SAW: '🇹🇷', ESB: '🇹🇷',
  AMM: '🇯🇴', BEY: '🇱🇧', CAI: '🇪🇬',
  DOH: '🇶🇦', KWI: '🇰🇼',
  RUH: '🇸🇦', JED: '🇸🇦', DMM: '🇸🇦', MED: '🇸🇦',
  BGW: '🇮🇶', NJF: '🇮🇶', EBL: '🇮🇶',
  OTP: '🇷🇴', GYD: '🇦🇿',
  LED: '🇷🇺', SVO: '🇷🇺',
  TAS: '🇺🇿', ALA: '🇰🇿', EVN: '🇦🇲',
  MJI: '🇱🇾', AMS: '🇳🇱',
}

// V2 — Syria palette status config
// `border` is the solid rail color on the FlightCard left strip
export const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; border: string }> = {
  Scheduled:   { label: 'Scheduled',   bg: '#EFEDE3', text: '#3D3A3B', border: '#D8D3BF' },
  Expected:    { label: 'Expected',    bg: '#F3EFE0', text: '#6E5F3C', border: '#988561' },
  CheckIn:     { label: 'Check-in',    bg: '#F3EFE0', text: '#6E5F3C', border: '#988561' },
  Boarding:    { label: 'Boarding',    bg: '#F3EFE0', text: '#6E5F3C', border: '#988561' },
  GateClosed:  { label: 'Gate Closed', bg: '#F3EFE0', text: '#6E5F3C', border: '#988561' },
  Departed:    { label: 'Departed',    bg: '#428177', text: '#FFFFFF', border: '#428177' },
  'En Route':  { label: 'En Route',   bg: '#428177', text: '#FFFFFF', border: '#428177' },
  Approaching: { label: 'Approaching', bg: '#428177', text: '#FFFFFF', border: '#428177' },
  Arrived:     { label: 'Arrived',     bg: '#E6EFEC', text: '#002623', border: '#9EBFB8' },
  Cancelled:   { label: 'Cancelled',   bg: '#F1E6E7', text: '#4A151E', border: '#6B1F2A' },
  Delayed:     { label: 'Delayed',     bg: '#F1E6E7', text: '#4A151E', border: '#6B1F2A' },
  Unknown:     { label: 'Unknown',     bg: '#EFEDE3', text: '#8A8578', border: '#D8D3BF' },
}

export function city(iata: string): string {
  return CITY[iata] ?? iata
}

export function airportFlag(iata: string): string {
  return AIRPORT_FLAG[iata] ?? ''
}

export function statusConfig(status: string) {
  return STATUS_CONFIG[status] ?? STATUS_CONFIG.Unknown
}

export function durationLabel(min: number): string {
  if (min <= 0) return ''
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function syriaDate(offsetDays = 0): string {
  const ms = Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

const UTC_OFFSET: Record<string, number> = {
  SHJ: 4, DXB: 4, AUH: 4, MCT: 4, EVN: 4, GYD: 4,
  AMS: 2, MJI: 2,
  TAS: 5, ALA: 5,
  LED: 3, SVO: 3,
}
export function tzOffset(iata: string): number {
  return UTC_OFFSET[iata] ?? 3
}

export function fmtLocal(utcStr: string | null | undefined, offsetH: number): string {
  if (!utcStr) return '--:--'
  let utcH: number, utcM: number
  if (/^\d{1,2}:\d{2}$/.test(utcStr)) {
    ;[utcH, utcM] = utcStr.split(':').map(Number)
  } else {
    const d = new Date(utcStr)
    if (isNaN(d.getTime())) return '--:--'
    utcH = d.getUTCHours()
    utcM = d.getUTCMinutes()
  }
  const totalMin = utcH * 60 + utcM + Math.round(offsetH * 60)
  const norm = ((totalMin % 1440) + 1440) % 1440
  const hh = String(Math.floor(norm / 60)).padStart(2, '0')
  const mm = String(norm % 60).padStart(2, '0')
  return `${hh}:${mm}`
}

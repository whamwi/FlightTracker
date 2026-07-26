export const API_BASE = 'https://flighttracker-sy.vercel.app'

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

export const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; border: string }> = {
  Scheduled:   { label: 'Scheduled',   bg: '#1f2937', text: '#9ca3af', border: '#374151' },
  Expected:    { label: 'Expected',    bg: '#422006', text: '#fde68a', border: '#ca8a04' },
  CheckIn:     { label: 'Check-in',   bg: '#431407', text: '#fcd34d', border: '#d97706' },
  Boarding:    { label: 'Boarding',    bg: '#431407', text: '#fde68a', border: '#f59e0b' },
  GateClosed:  { label: 'Gate Closed', bg: '#431407', text: '#fdba74', border: '#ea580c' },
  Departed:    { label: 'Departed',    bg: '#0c4a6e', text: '#bae6fd', border: '#0284c7' },
  'En Route':  { label: 'En Route',   bg: '#0c4a6e', text: '#bae6fd', border: '#0284c7' },
  Approaching: { label: 'Approaching', bg: '#042f2e', text: '#99f6e4', border: '#0d9488' },
  Arrived:     { label: 'Arrived',     bg: '#052e16', text: '#86efac', border: '#16a34a' },
  Cancelled:   { label: 'Cancelled',   bg: '#450a0a', text: '#fca5a5', border: '#dc2626' },
  Delayed:     { label: 'Delayed',     bg: '#450a0a', text: '#fca5a5', border: '#ef4444' },
  Unknown:     { label: 'Unknown',     bg: '#1f2937', text: '#6b7280', border: '#374151' },
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
  const d = new Date(utcStr)
  const totalMin = d.getUTCHours() * 60 + d.getUTCMinutes() + Math.round(offsetH * 60)
  const norm = ((totalMin % 1440) + 1440) % 1440
  const hh = String(Math.floor(norm / 60)).padStart(2, '0')
  const mm = String(norm % 60).padStart(2, '0')
  return `${hh}:${mm}`
}

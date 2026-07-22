import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ── Airport live-data Supabase sources ────────────────────────────────────────
const AIRPORT_SOURCES: Record<string, { url: string; key: string }> = {
  DAM: {
    url: 'https://ognrupehzbbckimkaikb.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nbnJ1cGVoemJiY2tpbWthaWtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ2ODc3NTIsImV4cCI6MjA4MDI2Mzc1Mn0.cBh06V2W7ocx8etUixo2lcdl1XH5RR4pTjXNOG59Xsg',
  },
  ALP: {
    url: 'https://ttqpvffxbouowufwbfze.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0cXB2ZmZ4Ym91b3d1ZndiZnplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY3ODU3NDMsImV4cCI6MjA4MjM2MTc0M30.A3j9iny8RusFtUt8J5mAyaj33cKEQJW9EPJw8iLtVWc',
  },
}

// ── Our own Supabase ───────────────────────────────────────────────────────────
const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!

async function sb(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string>),
    },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

// ── Flight number normalisation ───────────────────────────────────────────────
// damascusairport.com uses ICAO call-sign prefixes for some carriers (FYC = Fly Cham / XH)
const ICAO_PREFIX_TO_IATA: Record<string, string> = {
  FYC: 'XH',
}

function normalizeFlightNum(raw: string): string {
  for (const [icao, iata] of Object.entries(ICAO_PREFIX_TO_IATA)) {
    if (raw.startsWith(icao)) return iata + raw.slice(icao.length)
  }
  return raw
}

function parseFlight(raw: string): { carrier: string; flightnumber: number } {
  const normalized = normalizeFlightNum(raw.trim())
  const m = normalized.match(/^([A-Z\d]{2})\s*(\d+)/)
  return {
    carrier:      m?.[1] ?? normalized.slice(0, 2),
    flightnumber: parseInt(m?.[2] ?? '0', 10),
  }
}

// ── Route city name → IATA (damascusairport.com uses city names, not codes) ───
const ROUTE_TO_IATA: Record<string, string> = {
  'Abu Dhabi':   'AUH',
  'Amman':       'AMM',
  'Amsterdam':   'AMS',
  'Baghdad':     'BGW',
  'Bucharest':   'OTP',
  'Dammam':      'DMM',
  'Doha':        'DOH',
  'Dubai':       'DXB',
  'Erbil':       'EBL',
  'Istanbul':    'IST',
  'Jeddah':      'JED',
  'Kuwait City': 'KWI',
  'Muscat':      'MCT',
  'Riyadh':      'RUH',
  'Sharjah':     'SHJ',
}

// ── Flight payload structure (same for both airports) ─────────────────────────
interface DacFlight {
  type:              'arrival' | 'departure'
  flightNumber:      string
  airline:           string
  route:             string
  scheduledTime:     string   // Syria local "HH:MM"
  estimatedTime?:    string
  actualTime?:       string
  scheduledDateTime: string   // UTC ISO "2026-07-22T06:30:00.000Z"
  status:            string
  flightDate:        string
  countryCode?:      string
  aircraft?:         string
}

// ── Fetch from airport Supabase source ────────────────────────────────────────
async function fetchAirport(airport: string, date: string): Promise<{ arrivals: DacFlight[]; departures: DacFlight[] }> {
  const src = AIRPORT_SOURCES[airport]
  if (!src) throw new Error(`No source configured for ${airport}`)
  const res = await fetch(
    `${src.url}/rest/v1/flight_cache?id=eq.main&select=payload`,
    {
      headers: { apikey: src.key, Authorization: `Bearer ${src.key}` },
      signal: AbortSignal.timeout(15_000),
    }
  )
  if (!res.ok) throw new Error(`${airport} source: ${res.status}`)
  const data: [{ payload: DacFlight[] }] = await res.json()
  const today = (data[0]?.payload ?? []).filter(f => f.flightDate === date)
  return {
    arrivals:   today.filter(f => f.type === 'arrival'),
    departures: today.filter(f => f.type === 'departure'),
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  const url     = new URL(req.url)
  const date    = url.searchParams.get('date') ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
  const airport = (url.searchParams.get('airport') ?? 'DAM').toUpperCase()

  // Build IATA → ICAO lookup for carrier_icao field
  const airlines: { iata: string; icao: string | null }[] = await sb('/airlines?select=iata,icao')
  const iataToIcao = new Map(airlines.map(a => [a.iata, a.icao ?? null]))

  // Clear existing raw rows for this date+airport
  await sb(`/schedule_raw?schedule_date=eq.${date}&airport_iata=eq.${airport}`, { method: 'DELETE' })

  const { arrivals, departures } = await fetchAirport(airport, date)
  const rows: object[] = []

  for (const f of arrivals) {
    const { carrier, flightnumber } = parseFlight(f.flightNumber)
    rows.push({
      airport_iata:   airport,
      direction:      'arrival',
      carrier,
      carrier_icao:   iataToIcao.get(carrier) ?? null,
      flightnumber,
      iata_from:      ROUTE_TO_IATA[f.route] ?? f.route,
      iata_to:        airport,
      arr_time_local: f.scheduledTime,
      dep_time_local: null,
      duration_min:   null,
      schedule_date:  date,
      status:         f.status,
      airline_name:   f.airline,
    })
  }

  for (const f of departures) {
    const { carrier, flightnumber } = parseFlight(f.flightNumber)
    rows.push({
      airport_iata:   airport,
      direction:      'departure',
      carrier,
      carrier_icao:   iataToIcao.get(carrier) ?? null,
      flightnumber,
      iata_from:      airport,
      iata_to:        ROUTE_TO_IATA[f.route] ?? f.route,
      dep_time_local: f.scheduledTime,
      arr_time_local: null,
      duration_min:   null,
      schedule_date:  date,
      status:         f.status,
      airline_name:   f.airline,
    })
  }

  if (rows.length) {
    await sb('/schedule_raw', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(rows),
    })
  }

  return NextResponse.json({ ok: true, date, airport, arrivals: arrivals.length, departures: departures.length, loaded: rows.length })
}

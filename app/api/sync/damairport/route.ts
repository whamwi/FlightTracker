import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ── Damascus airport.com Supabase (richer source, covers all carriers) ─────────
const DAC_URL = 'https://ognrupehzbbckimkaikb.supabase.co'
const DAC_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nbnJ1cGVoemJiY2tpbWthaWtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ2ODc3NTIsImV4cCI6MjA4MDI2Mzc1Mn0.cBh06V2W7ocx8etUixo2lcdl1XH5RR4pTjXNOG59Xsg'

// ── Aleppo official API (no third-party source yet) ───────────────────────────
const AIRPORT_API: Record<string, string> = {
  ALP: 'https://alpairport.gov.sy/api/flights.php',
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

// ── DAM: fetch from damascusairport.com Supabase ──────────────────────────────
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

async function fetchDAM(date: string): Promise<{ arrivals: DacFlight[]; departures: DacFlight[] }> {
  const res = await fetch(
    `${DAC_URL}/rest/v1/flight_cache?id=eq.main&select=payload`,
    {
      headers: { apikey: DAC_KEY, Authorization: `Bearer ${DAC_KEY}` },
      signal: AbortSignal.timeout(15_000),
    }
  )
  if (!res.ok) throw new Error(`damascusairport.com Supabase: ${res.status}`)
  const data: [{ payload: DacFlight[] }] = await res.json()
  const today = (data[0]?.payload ?? []).filter(f => f.flightDate === date)
  return {
    arrivals:   today.filter(f => f.type === 'arrival'),
    departures: today.filter(f => f.type === 'departure'),
  }
}

// ── ALP: fetch from official gov.sy API (paginated) ───────────────────────────
interface AlpFlight {
  flightNumber: string
  airline:      string
  direction:    string
  origin:       string
  destination:  string
  date:         string
  time:         string
  status:       string
}

// Airport API sometimes returns city codes — normalize to airport IATA
const IATA_REMAP: Record<string, string> = {
  BUH: 'OTP',
}
function remapIata(code: string): string {
  return IATA_REMAP[code] ?? code
}

const ALP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Accept: 'application/json, text/plain, */*',
}

async function fetchAlpPage(apiUrl: string, date: string, dir: 'arrival' | 'departure', wfloor: string, page: number): Promise<AlpFlight[]> {
  const params = new URLSearchParams({ paged: '1', dir, wfloor, dexact: date, page: String(page) })
  const res = await fetch(`${apiUrl}?${params}`, { headers: ALP_HEADERS, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) return []
  const json = await res.json()
  return json?.flights ?? json ?? []
}

async function fetchALP(date: string): Promise<{ arrivals: AlpFlight[]; departures: AlpFlight[] }> {
  const apiUrl = AIRPORT_API.ALP
  const wfloor = new Date(new Date(date).getTime() - 4 * 86400_000).toISOString().slice(0, 10)

  async function fetchDir(dir: 'arrival' | 'departure'): Promise<AlpFlight[]> {
    const first = await fetchAlpPage(apiUrl, date, dir, wfloor, 1)
    if (!first.length) return []
    const rest = await Promise.all(
      Array.from({ length: 15 }, (_, i) => fetchAlpPage(apiUrl, date, dir, wfloor, i + 2))
    )
    const seen = new Set<string>()
    const all: AlpFlight[] = []
    for (const f of [...first, ...rest.flat()]) {
      const key = `${f.flightNumber}|${f.origin}|${f.destination}|${f.time}`
      if (!seen.has(key)) { seen.add(key); all.push(f) }
    }
    return all
  }

  const [arrivals, departures] = await Promise.all([fetchDir('arrival'), fetchDir('departure')])
  return { arrivals, departures }
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

  const rows: object[] = []

  if (airport === 'DAM') {
    const { arrivals, departures } = await fetchDAM(date)

    for (const f of arrivals) {
      const { carrier, flightnumber } = parseFlight(f.flightNumber)
      const iata_from = ROUTE_TO_IATA[f.route] ?? f.route
      rows.push({
        airport_iata:   'DAM',
        direction:      'arrival',
        carrier,
        carrier_icao:   iataToIcao.get(carrier) ?? null,
        flightnumber,
        iata_from,
        iata_to:        'DAM',
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
      const iata_to = ROUTE_TO_IATA[f.route] ?? f.route
      rows.push({
        airport_iata:   'DAM',
        direction:      'departure',
        carrier,
        carrier_icao:   iataToIcao.get(carrier) ?? null,
        flightnumber,
        iata_from:      'DAM',
        iata_to,
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

  } else {
    // ALP: gov.sy API
    const { arrivals, departures } = await fetchALP(date)

    for (const f of arrivals) {
      const { carrier, flightnumber } = parseFlight(f.flightNumber)
      rows.push({
        airport_iata:   airport,
        direction:      'arrival',
        carrier,
        carrier_icao:   iataToIcao.get(carrier) ?? null,
        flightnumber,
        iata_from:      remapIata(f.origin),
        iata_to:        remapIata(f.destination),
        arr_time_local: f.time,
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
        iata_from:      remapIata(f.origin),
        iata_to:        remapIata(f.destination),
        dep_time_local: f.time,
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
}

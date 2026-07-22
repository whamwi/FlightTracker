import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const AIRPORT_API: Record<string, string> = {
  DAM: 'https://damairport.gov.sy/api/flights.php',
  ALP: 'https://alpairport.gov.sy/api/flights.php',
}
const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!

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

interface DamFlight {
  flightNumber: string   // "XH 524"
  airline:      string   // "Fly Cham"
  direction:    string   // "arrival" | "departure"
  origin:       string   // IATA
  destination:  string   // IATA
  date:         string   // "2026-07-22"
  time:         string   // "00:10" — arr time at DAM for arrivals, dep time from DAM for departures
  status:       string   // "scheduled" | "landed" | etc.
}

const DAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
}

async function fetchPage(apiUrl: string, date: string, dir: 'arrival' | 'departure', wfloor: string, page: number): Promise<DamFlight[]> {
  const params = new URLSearchParams({ paged: '1', dir, wfloor, dexact: date, page: String(page) })
  const res = await fetch(`${apiUrl}?${params}`, { headers: DAM_HEADERS, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) return []
  const json = await res.json()
  // API wraps results: { ok: true, flights: [...] }
  return json?.flights ?? json ?? []
}

async function fetchDirection(apiUrl: string, date: string, dir: 'arrival' | 'departure'): Promise<DamFlight[]> {
  const wfloor = new Date(new Date(date).getTime() - 4 * 86400_000).toISOString().slice(0, 10)

  // Fetch page 1 first to confirm connectivity, then parallel-fetch remaining pages
  const firstPage = await fetchPage(apiUrl, date, dir, wfloor, 1)
  if (!firstPage.length) return []

  // Fetch up to 15 more pages in parallel (covers 80 flights max)
  const remaining = await Promise.all(
    Array.from({ length: 15 }, (_, i) => fetchPage(apiUrl, date, dir, wfloor, i + 2))
  )

  // Deduplicate by flight identity — the API repeats the last page for out-of-range page numbers
  const seen = new Set<string>()
  const all: DamFlight[] = []
  for (const f of [...firstPage, ...remaining.flat()]) {
    const key = `${f.flightNumber}|${f.origin}|${f.destination}|${f.time}`
    if (!seen.has(key)) { seen.add(key); all.push(f) }
  }
  return all
}

export async function GET(req: Request) {
  const url     = new URL(req.url)
  const date    = url.searchParams.get('date') ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
  const airport = (url.searchParams.get('airport') ?? 'DAM').toUpperCase()
  const apiUrl  = AIRPORT_API[airport] ?? AIRPORT_API.DAM

  // Build IATA → ICAO/broadcast lookup from airlines table
  const airlines: { iata: string; icao: string | null }[] = await sb('/airlines?select=iata,icao')
  const iataToIcao = new Map(airlines.map(a => [a.iata, a.icao ?? null]))

  // Fetch both directions concurrently
  const [arrivals, departures] = await Promise.all([
    fetchDirection(apiUrl, date, 'arrival'),
    fetchDirection(apiUrl, date, 'departure'),
  ])

  // Clear existing rows for this date + airport before reloading
  await sb(`/schedule_raw?schedule_date=eq.${date}&airport_iata=eq.${airport}`, { method: 'DELETE' })

  // Parse "XH 524" or "XH524" → carrier="XH", flightnumber=524
  function parseFlight(raw: string): { carrier: string; flightnumber: number } {
    const m = raw.trim().match(/^([A-Z\d]{2})\s*(\d+)/)
    return { carrier: m?.[1] ?? raw.trim().slice(0, 2), flightnumber: parseInt(m?.[2] ?? '0', 10) }
  }

  const rows: object[] = []

  for (const f of arrivals) {
    const { carrier, flightnumber } = parseFlight(f.flightNumber)
    rows.push({
      airport_iata:   airport,
      direction:      'arrival',
      carrier,
      carrier_icao:   iataToIcao.get(carrier) ?? null,
      flightnumber,
      iata_from:      f.origin,
      iata_to:        f.destination,
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
      iata_from:      f.origin,
      iata_to:        f.destination,
      dep_time_local: f.time,
      arr_time_local: null,
      duration_min:   null,
      schedule_date:  date,
      status:         f.status,
      airline_name:   f.airline,
    })
  }

  if (rows.length > 0) {
    await sb('/schedule_raw', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(rows),
    })
  }

  return NextResponse.json({
    ok:         true,
    date,
    airport,
    arrivals:   arrivals.length,
    departures: departures.length,
    loaded:     rows.length,
  })
}

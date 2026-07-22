import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const DAM_API = 'https://damairport.gov.sy/api/flights.php'
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
  direction:    string   // "arrival" | "departure"
  origin:       string   // IATA
  destination:  string   // IATA
  date:         string   // "2026-07-22"
  time:         string   // "00:10" — arr time at DAM for arrivals, dep time from DAM for departures
  status:       string   // "scheduled" | "landed" | etc.
}

async function fetchDirection(date: string, dir: 'arrival' | 'departure'): Promise<DamFlight[]> {
  const wfloor = new Date(new Date(date).getTime() - 7 * 86400_000).toISOString().slice(0, 10)
  const all: DamFlight[] = []
  let page = 1

  while (true) {
    const params = new URLSearchParams({ paged: '1', dir, wfloor, dexact: date, page: String(page) })
    const res = await fetch(`${DAM_API}?${params}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) break
    const data: DamFlight[] = await res.json()
    if (!data?.length) break
    all.push(...data)
    page++
  }

  return all
}

export async function GET(req: Request) {
  const url     = new URL(req.url)
  const date    = url.searchParams.get('date') ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
  const airport = (url.searchParams.get('airport') ?? 'DAM').toUpperCase()

  // Build IATA → ICAO/broadcast lookup from airlines table
  const airlines: { iata: string; icao: string | null }[] = await sb('/airlines?select=iata,icao')
  const iataToIcao = new Map(airlines.map(a => [a.iata, a.icao ?? null]))

  // Fetch both directions concurrently
  const [arrivals, departures] = await Promise.all([
    fetchDirection(date, 'arrival'),
    fetchDirection(date, 'departure'),
  ])

  // Clear existing rows for this date + airport before reloading
  await sb(`/schedule_raw?schedule_date=eq.${date}&airport_iata=eq.${airport}`, { method: 'DELETE' })

  const rows: object[] = []

  for (const f of arrivals) {
    const [carrier, numStr] = f.flightNumber.trim().split(/\s+/)
    rows.push({
      airport_iata:  airport,
      direction:     'arrival',
      carrier,
      carrier_icao:  iataToIcao.get(carrier) ?? null,
      flightnumber:  parseInt(numStr ?? '0', 10),
      iata_from:     f.origin,
      iata_to:       f.destination,
      arr_time_local: f.time,   // scheduled arrival at DAM
      dep_time_local: null,
      duration_min:  null,
      schedule_date: date,
      status:        f.status,
    })
  }

  for (const f of departures) {
    const [carrier, numStr] = f.flightNumber.trim().split(/\s+/)
    rows.push({
      airport_iata:  airport,
      direction:     'departure',
      carrier,
      carrier_icao:  iataToIcao.get(carrier) ?? null,
      flightnumber:  parseInt(numStr ?? '0', 10),
      iata_from:     f.origin,
      iata_to:       f.destination,
      dep_time_local: f.time,   // scheduled departure from DAM
      arr_time_local: null,
      duration_min:  null,
      schedule_date: date,
      status:        f.status,
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

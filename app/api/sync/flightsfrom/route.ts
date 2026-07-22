import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!

const FF_BASE = 'https://www.flightsfrom.com/api/airport'
const FF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.flightsfrom.com/',
}

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

interface ScheduleEntry {
  carrier: string
  flightnumber: number
  iata_from: string
  iata_to: string
  departure_time: string
  arrival_time: string
  elapsed_time: number
  date_from: string
  date_to: string
}

async function fetchSchedule(airport: string, direction: 'departures' | 'arrivals', date: string): Promise<ScheduleEntry[]> {
  const params = new URLSearchParams({
    from: airport,
    entityType: direction,
    take: '200',
    sorting: 'departure-time',
    sortingDirection: 'asc',
    selectedDate: date,
    dateMethod: 'day',
    dateFrom: date,
    dateTo: date,
    state: '1',
  })
  const res = await fetch(`${FF_BASE}/${airport}?${params}`, {
    headers: FF_HEADERS,
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`FlightsFrom ${airport}/${direction}: ${res.status}`)
  const data = await res.json()
  return (data?.response?.schedule?.result as ScheduleEntry[]) ?? []
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const dateParam = url.searchParams.get('date')
  const airports = (url.searchParams.get('airports') ?? 'DAM').toUpperCase().split(',')

  // Default to today in Syria time (UTC+3)
  const date = dateParam ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)

  try {
    // Delete existing rows for this date + airports so we get a clean reload
    for (const airport of airports) {
      await sb(`/schedule_raw?schedule_date=eq.${date}&airport_iata=eq.${airport}`, { method: 'DELETE' })
    }

    const rows: object[] = []

    for (const airport of airports) {
      const [deps, arrs] = await Promise.all([
        fetchSchedule(airport, 'departures', date),
        fetchSchedule(airport, 'arrivals', date),
      ])

      for (const f of deps) {
        rows.push({
          airport_iata:  airport,
          direction:     'departure',
          carrier:       f.carrier,
          flightnumber:  f.flightnumber,
          iata_from:     f.iata_from,
          iata_to:       f.iata_to,
          dep_time_local: f.departure_time,
          arr_time_local: f.arrival_time.slice(0, 5),
          duration_min:  f.elapsed_time,
          schedule_date: date,
          date_from:     f.date_from || null,
          date_to:       f.date_to || null,
        })
      }

      for (const f of arrs) {
        rows.push({
          airport_iata:  airport,
          direction:     'arrival',
          carrier:       f.carrier,
          flightnumber:  f.flightnumber,
          iata_from:     f.iata_from,
          iata_to:       f.iata_to,
          dep_time_local: f.departure_time,
          arr_time_local: f.arrival_time.slice(0, 5),
          duration_min:  f.elapsed_time,
          schedule_date: date,
          date_from:     f.date_from || null,
          date_to:       f.date_to || null,
        })
      }
    }

    if (rows.length > 0) {
      await sb('/schedule_raw', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(rows),
      })
    }

    return NextResponse.json({ ok: true, date, airports, loaded: rows.length })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

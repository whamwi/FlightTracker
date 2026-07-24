import { NextResponse } from 'next/server'

export const dynamic   = 'force-dynamic'
export const maxDuration = 45

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const SB_HEADERS = {
  apikey:         SB_KEY,
  Authorization:  `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  Prefer:         'resolution=merge-duplicates,return=minimal',
}

const AIRPORTS = ['DAM', 'ALP', 'LTK']
const TZ       = 'Asia/Damascus'

// Midnight Damascus time for a given date string (YYYY-MM-DD) → Unix seconds
function damMidnightUnix(dateStr: string): number {
  return Math.floor(new Date(`${dateStr}T00:00:00+03:00`).getTime() / 1000)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeFlight(f: any): object | null {
  const fl  = f?.flight
  if (!fl) return null

  const num        = fl.identification?.number?.default
  const airline    = fl.airline?.name ?? null
  const airlineIata = fl.airline?.code?.iata ?? null
  const depIata    = fl.airport?.origin?.destination?.code?.iata
                  ?? fl.airport?.origin?.code?.iata ?? null
  const arrIata    = fl.airport?.destination?.code?.iata ?? null
  const schedDep   = fl.time?.scheduled?.departure ?? null
  const schedArr   = fl.time?.scheduled?.arrival   ?? null
  const status     = fl.status?.generic?.status?.text ?? fl.status?.text ?? null

  if (!num || !schedDep || !schedArr) return null

  const durationMin = Math.round((schedArr - schedDep) / 60)

  return { num, airline, airline_iata: airlineIata, dep_iata: depIata, arr_iata: arrIata, sched_dep: schedDep, sched_arr: schedArr, duration_min: durationMin, status }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSchedule(data: any): { arrivals: object[]; departures: object[] } {
  const sched      = data?.result?.response?.airport?.pluginData?.schedule ?? {}
  const arrData    = sched.arrivals?.data  ?? []
  const depData    = sched.departures?.data ?? []

  const arrivals   = arrData.map(normalizeFlight).filter(Boolean)  as object[]
  const departures = depData.map(normalizeFlight).filter(Boolean)  as object[]

  return { arrivals, departures }
}

async function fetchFR24(airport: string, dateStr: string): Promise<{ arrivals: object[]; departures: object[] } | null> {
  const ts  = damMidnightUnix(dateStr)
  const url = `https://api.flightradar24.com/common/v1/airport.json?code=${airport}&plugin=&plugin-setting[schedule][mode]=&plugin-setting[schedule][timestamp]=${ts}&page=1&limit=100&fleet=&token=`

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept':     'application/json, text/plain, */*',
        'Referer':    'https://www.flightradar24.com/',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.error(`[fr24-sync] FR24 ${airport} HTTP ${res.status}`)
      return null
    }
    return parseSchedule(await res.json())
  } catch (e) {
    console.error(`[fr24-sync] FR24 ${airport} error:`, e)
    return null
  }
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  // Default: yesterday in Damascus time — gives us a completed day
  const { searchParams } = new URL(req.url)
  const forceDate = searchParams.get('date')
  const yesterday = new Date(Date.now() - 24 * 3600_000)
    .toLocaleDateString('en-CA', { timeZone: TZ })  // YYYY-MM-DD
  const targetDate = forceDate ?? yesterday

  const summary: string[] = []
  const rows: object[]    = []

  for (const airport of AIRPORTS) {
    const result = await fetchFR24(airport, targetDate)
    if (!result) {
      summary.push(`${airport}: fetch failed`)
      continue
    }

    rows.push({
      airport_iata: airport,
      flight_date:  targetDate,
      arrivals:     result.arrivals,
      departures:   result.departures,
      arr_count:    result.arrivals.length,
      dep_count:    result.departures.length,
      fetched_at:   new Date().toISOString(),
    })

    summary.push(`${airport}: ${result.arrivals.length} arr, ${result.departures.length} dep`)
  }

  if (rows.length > 0) {
    const res = await fetch(`${SB_URL}/rest/v1/fr24_daily_cache`, {
      method:  'POST',
      headers: SB_HEADERS,
      body:    JSON.stringify(rows),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error('[fr24-sync] upsert failed:', err)
      return NextResponse.json({ ok: false, error: err }, { status: 502 })
    }
  }

  return NextResponse.json({ ok: true, date: targetDate, summary, upserted: rows.length })
}

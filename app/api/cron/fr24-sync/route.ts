import { NextResponse } from 'next/server'

export const dynamic   = 'force-dynamic'
export const maxDuration = 60

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const FR24_KEY = process.env.FR24_API_KEY!

const AIRPORTS = ['DAM', 'ALP']
const TZ       = 'Asia/Damascus'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeFlight(f: any, airportIata: string): { arr: object | null; dep: object | null } {
  const base = {
    fr24_id:      f.fr24_id ?? null,
    num:          f.flight ?? null,
    airline_iata: f.operating_as ?? f.painted_as ?? null,
    dep_iata:     f.orig_iata ?? null,
    arr_iata:     f.dest_iata_actual ?? f.dest_iata ?? null,
    aircraft:     f.type ?? null,
    reg:          f.reg ?? null,
    flight_time:  f.flight_time ?? null,
    // actual times (ISO strings → convert to unix for consistency)
    actual_dep:   f.datetime_takeoff ? Math.floor(new Date(f.datetime_takeoff).getTime() / 1000) : null,
    actual_arr:   f.datetime_landed  ? Math.floor(new Date(f.datetime_landed).getTime()  / 1000) : null,
    flight_ended: f.flight_ended ?? false,
  }

  const isArr = base.arr_iata === airportIata
  const isDep = base.dep_iata === airportIata

  return {
    arr: isArr ? base : null,
    dep: isDep ? base : null,
  }
}

async function fetchSummary(airport: string, dateStr: string): Promise<{ arrivals: object[]; departures: object[] } | null> {
  const from = `${dateStr}T00:00:00Z`
  const to   = `${dateStr}T23:59:59Z`
  const arrivals:   object[] = []
  const departures: object[] = []

  let cursor: string | null = null
  let page = 0

  while (page < 10) {
    const params = new URLSearchParams({
      airports:              airport,
      flight_datetime_from:  from,
      flight_datetime_to:    to,
      limit:                 '100',
      categories:            'P',   // Passenger only
    })
    if (cursor) params.set('cursor', cursor)

    const url = `https://fr24api.flightradar24.com/api/flight-summary/full?${params}`
    let res: Response
    try {
      res = await fetch(url, {
        headers: {
          'Authorization':  `Bearer ${FR24_KEY}`,
          'Accept':         'application/json',
          'Accept-Version': 'v1',
        },
        signal: AbortSignal.timeout(20_000),
      })
    } catch (e) {
      console.error(`[fr24-sync] fetch error ${airport} page ${page}:`, e)
      break
    }

    if (!res.ok) {
      console.error(`[fr24-sync] HTTP ${res.status} for ${airport}`)
      return null
    }

    const body = await res.json() as { data: object[]; meta?: { cursor?: string } }
    const flights = body.data ?? []

    for (const f of flights) {
      const { arr, dep } = normalizeFlight(f, airport)
      if (arr) arrivals.push(arr)
      if (dep) departures.push(dep)
    }

    cursor = body.meta?.cursor ?? null
    if (!cursor || flights.length === 0) break
    page++
  }

  return { arrivals, departures }
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const forceDate = searchParams.get('date')
  // Default to today (Syria time, UTC+3) so the scheduled cron keeps today's board fresh.
  // Pass ?date=yesterday to backfill the previous day's completed flights.
  const today = new Date(Date.now() + 3 * 3_600_000)
    .toISOString().slice(0, 10)
  const targetDate = forceDate === 'yesterday'
    ? new Date(Date.now() - 21 * 3_600_000).toISOString().slice(0, 10)  // ~UTC+3 yesterday
    : forceDate ?? today

  const summary: string[] = []
  const rows: object[]    = []

  for (const airport of AIRPORTS) {
    const result = await fetchSummary(airport, targetDate)
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
    // Only upsert rows where Business API has more arrivals than what's cached
    // (browser write-through from widget is more complete for DAM due to partial ADS-B coverage)
    const existRes = await fetch(
      `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${targetDate}&select=airport_iata,arr_count`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    )
    const existing: { airport_iata: string; arr_count: number }[] = existRes.ok ? await existRes.json() : []
    const existMap = Object.fromEntries(existing.map(r => [r.airport_iata, r.arr_count]))

    const toUpsert = rows.filter((r: object) => {
      const row = r as { airport_iata: string; arr_count: number }
      const cached = existMap[row.airport_iata] ?? 0
      return row.arr_count > cached  // only replace if we have more data
    })

    if (toUpsert.length > 0) {
      const res = await fetch(`${SB_URL}/rest/v1/fr24_daily_cache`, {
        method:  'POST',
        headers: {
          apikey:         SB_KEY,
          Authorization:  `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json',
          Prefer:         'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(toUpsert),
      })
      if (!res.ok) {
        const err = await res.text()
        console.error('[fr24-sync] upsert failed:', err)
        return NextResponse.json({ ok: false, error: err }, { status: 502 })
      }
    }
    summary.push(`upserted ${toUpsert.length}/${rows.length} (skipped where browser had more data)`)
  }

  return NextResponse.json({ ok: true, date: targetDate, summary, upserted: rows.length })
}

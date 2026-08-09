import { NextResponse } from 'next/server'

/**
 * Everything the Statistics tab shows, in one response.
 *
 * Reads the rolled-up daily_stats rather than the raw cache: the rollup is the only thing that
 * will still know about July in October, and serving the page from the same table the history
 * lives in means the page cannot quietly disagree with itself as days age out.
 *
 * Top routes and airline punctuality are still computed live from the cache, because they need
 * per-leg detail the daily rows deliberately do not keep. They therefore only ever describe
 * the window the cache still holds, and the response says so rather than leaving the reader to
 * assume it covers the same period as the totals.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const ON_TIME_MIN = 15
/** Below this a percentage is noise: one bad morning moves it ten points. */
const MIN_LEGS = 20

type Leg = {
  num?: string; status?: string; airline?: string; airline_iata?: string
  sched_dep?: number | string; real_dep?: number | string | null
  dep_iata?: string | null; arr_iata?: string | null
}

export async function GET(req: Request) {
  const days = Math.min(Number(new URL(req.url).searchParams.get('days') ?? 30), 120)
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  /*
   * Today, in Damascus, so the tables stop at flights that have actually operated.
   *
   * fr24_daily_cache holds the days ahead as well as the days behind — the board caches
   * tomorrow's schedule — so an unbounded read counted flights that have not happened. It is
   * why "flights tracked" ran ahead of "with a recorded departure time" by more than
   * cancellations could explain.
   */
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Damascus' })

  const [dailyRes, cacheRes] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/daily_stats?stat_date=gte.${from}&select=*&order=stat_date.asc`,
      { headers: HEADERS, cache: 'no-store' }),
    /*
     * Bounded by the same window as the daily series above, and stopped at today.
     *
     * This read had no date filter at all, so the two halves of the panel described different
     * periods: the charts rolled the last `days`, while the headline metrics and both tables
     * summed whatever the cache had ever held. Nothing prunes that table, so the window was
     * not rolling but growing — "since 24 July" today, and still "since 24 July" a year from
     * now, by which point a route that stopped flying in August would keep its rank forever
     * and the count would compare with nothing.
     */
    fetch(`${SB_URL}/rest/v1/fr24_daily_cache?airport_iata=in.(DAM,ALP)&flight_date=gte.${from}&flight_date=lte.${today}&select=flight_date,airport_iata,arrivals,departures`,
      { headers: HEADERS, cache: 'no-store' }),
  ])

  const daily: Record<string, unknown>[] = dailyRes.ok ? await dailyRes.json() : []
  const cache: { flight_date: string; airport_iata: string; arrivals: Leg[]; departures: Leg[] }[] =
    cacheRes.ok ? await cacheRes.json() : []

  // ── Live detail from whatever the cache still holds ────────────────────────
  const seen = new Set<string>()
  const legs: { airline: string; airlineIata: string | null; route: string; delay: number | null }[] = []
  let cacheFrom = '', cacheTo = ''

  for (const row of cache) {
    if (!cacheFrom || row.flight_date < cacheFrom) cacheFrom = row.flight_date
    if (!cacheTo   || row.flight_date > cacheTo)   cacheTo   = row.flight_date
    for (const l of [...(row.arrivals ?? []), ...(row.departures ?? [])]) {
      const key = `${row.flight_date}|${l.num ?? ''}|${l.sched_dep ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      const sched = Number(l.sched_dep)
      const real  = l.real_dep == null || l.real_dep === '' ? NaN : Number(l.real_dep)
      let delay: number | null = null
      if (Number.isFinite(sched) && Number.isFinite(real)) {
        const d = (real - sched) / 60
        if (Math.abs(d) <= 12 * 60) delay = d
      }
      const other = l.arr_iata ?? l.dep_iata
      legs.push({
        airline: l.airline ?? l.airline_iata ?? '—',
        // Carried alongside the display name, not instead of it. The name is what this
        // endpoint has always returned and something may still be reading it; the code is what
        // a client needs to look the carrier up in its own table.
        airlineIata: l.airline_iata ?? null,
        route: other ? `${row.airport_iata}–${other}` : '—',
        delay,
      })
    }
  }

  type Group = { n: number; measured: number; onTime: number; total: number; name: string; iata: string | null }

  const summarise = (
    keyOf: (l: typeof legs[number]) => string,
    metaOf?: (l: typeof legs[number]) => { name: string; iata: string | null },
  ) => {
    const g = new Map<string, Group>()
    for (const l of legs) {
      const k = keyOf(l)
      if (k === '—') continue
      const e = g.get(k) ?? { n: 0, measured: 0, onTime: 0, total: 0, ...(metaOf?.(l) ?? { name: k, iata: null }) }
      e.n++
      if (l.delay != null) { e.measured++; e.total += l.delay; if (l.delay <= ON_TIME_MIN) e.onTime++ }
      g.set(k, e)
    }
    return [...g.values()]
      .filter(e => e.n >= MIN_LEGS)
      .map(e => ({
        name: e.name,
        iata: e.iata,
        flights: e.n,
        on_time_pct: e.measured ? Math.round((100 * e.onTime) / e.measured) : null,
        avg_delay_min: e.measured ? Math.round(e.total / e.measured) : null,
      }))
  }

  /*
   * Grouped by code where there is one, not by display name.
   *
   * The name was the key, which merged Air Arabia's two airlines: G9 out of Sharjah and 3L out
   * of Abu Dhabi both file as "Air Arabia" and were being averaged into a single row despite
   * being separate carriers with separate punctuality. Keying on the code splits them, and
   * gives clients something to translate against — the names here are this endpoint's own and
   * do not match the airlines table ("Syrian Air" against "Syrian Arab Airlines", "AJet"
   * against "Anadolujet"), so a name is not something anyone can look a carrier up by.
   */
  const airlines = summarise(
    l => l.airlineIata || l.airline,
    l => ({ name: l.airline, iata: l.airlineIata }),
  ).sort((a, b) => (b.on_time_pct ?? -1) - (a.on_time_pct ?? -1))
  const routes   = summarise(l => l.route).sort((a, b) => b.flights - a.flights).slice(0, 10)

  const measured = legs.filter(l => l.delay != null)
  const overall = {
    flights: legs.length,
    measured: measured.length,
    on_time_pct: measured.length
      ? Math.round((100 * measured.filter(l => (l.delay as number) <= ON_TIME_MIN).length) / measured.length)
      : null,
    avg_delay_min: measured.length
      ? Math.round(measured.reduce((s, l) => s + (l.delay as number), 0) / measured.length)
      : null,
    from: cacheFrom,
    to: cacheTo,
  }

  return NextResponse.json({
    ok: true,
    // Two different periods in one payload, labelled: the totals go back as far as the rollup
    // has been running, the rankings only as far as the cache still reaches.
    daily,
    overall,
    airlines,
    routes,
    min_legs: MIN_LEGS,
  })
}

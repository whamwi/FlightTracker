import { NextResponse } from 'next/server'

/**
 * Roll the board cache up into one row per airport per day.
 *
 * fr24_daily_cache is a moving 14-day window — 24 July had already decayed from a full day to
 * three rows by 4 August. Everything a statistics page could ever say about a month, a season
 * or a year has to be captured before that happens, and none of it can be recovered
 * afterwards. This job is the only reason long-run figures will exist.
 *
 * Runs over a window rather than yesterday alone, because a day's numbers keep improving for
 * a while: flights land late, actual times arrive after the fact, and a row written at
 * midnight is less complete than the same row written two days later. Re-running is safe —
 * the upsert replaces.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }

const AIRPORTS = ['DAM', 'ALP']
/** Days back to recompute each run. Comfortably longer than late arrivals take to settle. */
const WINDOW_DAYS = 5
/** The industry convention: a departure inside fifteen minutes counts as on time. */
const ON_TIME_MIN = 15

type Leg = {
  num?: string
  status?: string
  sched_dep?: number | string
  real_dep?: number | string | null
  airline_iata?: string
  dep_iata?: string | null
  arr_iata?: string | null
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const url  = new URL(req.url)
  const days = Number(url.searchParams.get('days') ?? WINDOW_DAYS)
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

  const res = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=gte.${from}` +
    `&airport_iata=in.(${AIRPORTS.join(',')})&select=flight_date,airport_iata,arrivals,departures`,
    { headers: HEADERS, cache: 'no-store' },
  )
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `cache ${res.status}` }, { status: 502 })
  }
  const rows: { flight_date: string; airport_iata: string; arrivals: Leg[]; departures: Leg[] }[] = await res.json()

  const out = rows.map(r => {
    const arrivals   = r.arrivals   ?? []
    const departures = r.departures ?? []

    // Both directions, deduped on flight number: the same leg can appear in this airport's
    // arrivals and in the counterpart airport's departures, and counting it twice would
    // inflate every figure on the page.
    const seen = new Set<string>()
    const legs: Leg[] = []
    for (const l of [...arrivals, ...departures]) {
      const key = `${l.num ?? ''}|${l.sched_dep ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      legs.push(l)
    }

    const delays: number[] = []
    let onTime = 0, cancelled = 0, diverted = 0
    const airlines = new Set<string>()
    const routes   = new Set<string>()

    for (const l of legs) {
      const st = (l.status ?? '').toLowerCase()
      if (st.includes('cancel')) cancelled++
      if (st.includes('divert')) diverted++
      if (l.airline_iata) airlines.add(l.airline_iata)
      const other = l.arr_iata ?? l.dep_iata
      if (other) routes.add(`${r.airport_iata}-${other}`)

      const sched = Number(l.sched_dep)
      const real  = l.real_dep == null || l.real_dep === '' ? NaN : Number(l.real_dep)
      if (!Number.isFinite(sched) || !Number.isFinite(real)) continue
      const d = (real - sched) / 60
      // A twelve-hour swing is a data error, not a delay, and one of them would drag a day's
      // mean by minutes.
      if (Math.abs(d) > 12 * 60) continue
      delays.push(d)
      if (d <= ON_TIME_MIN) onTime++
    }

    return {
      stat_date:    r.flight_date,
      airport_iata: r.airport_iata,
      arrivals:     arrivals.length,
      departures:   departures.length,
      measured:     delays.length,
      on_time:      onTime,
      avg_delay_min:    delays.length ? Number((delays.reduce((a, b) => a + b, 0) / delays.length).toFixed(1)) : null,
      median_delay_min: delays.length ? Number((median(delays) ?? 0).toFixed(1)) : null,
      cancelled,
      diverted,
      airlines: airlines.size,
      routes:   routes.size,
      computed_at: new Date().toISOString(),
    }
  })

  if (out.length) {
    const up = await fetch(`${SB_URL}/rest/v1/daily_stats`, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(out),
    })
    if (!up.ok) {
      return NextResponse.json({ ok: false, error: `upsert ${up.status}: ${await up.text()}` }, { status: 502 })
    }
  }

  return NextResponse.json({ ok: true, from, days_written: out.length, rows: out })
}

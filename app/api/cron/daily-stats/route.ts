import { NextResponse } from 'next/server'
import { SYRIA_AIRPORTS } from '@/lib/syria-airports'

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

const AIRPORTS: readonly string[] = SYRIA_AIRPORTS
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

  /*
   * `flight`, not fr24_daily_cache.
   *
   * One row per leg, so the num|sched_dep dedup is gone — that existed because the same leg
   * appears in this airport's arrivals and the counterpart's departures, and the cache stored
   * both copies. A leg still counts for two airports here, which is intended: a DAM-ALP flight
   * is a departure at Damascus and an arrival at Aleppo.
   *
   * Cancelled and diverted come from `outcome` rather than from matching substrings in FR24's
   * free text, which is what the trigger now carries.
   */
  const res = await fetch(
    `${SB_URL}/rest/v1/flight?flight_date=gte.${from}`
      + `&select=flight_date,dep_iata,arr_iata,airline_iata,sched_dep,real_dep,outcome`,
    { headers: HEADERS, cache: 'no-store' },
  )
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `flight ${res.status}` }, { status: 502 })
  }
  type Row = {
    flight_date: string; dep_iata: string | null; arr_iata: string | null
    airline_iata: string | null; sched_dep: string | null; real_dep: string | null
    outcome: string | null
  }
  const rows: Row[] = await res.json()

  type Bucket = {
    arrivals: number; departures: number; delays: number[]; onTime: number
    cancelled: number; diverted: number; airlines: Set<string>; routes: Set<string>
  }
  const buckets = new Map<string, Bucket>()
  const bucket = (date: string, ap: string): Bucket => {
    const k = `${date}|${ap}`
    let b = buckets.get(k)
    if (!b) {
      b = { arrivals: 0, departures: 0, delays: [], onTime: 0, cancelled: 0, diverted: 0,
            airlines: new Set(), routes: new Set() }
      buckets.set(k, b)
    }
    return b
  }

  for (const l of rows) {
    const dep = l.dep_iata ?? '', arr = l.arr_iata ?? ''
    const ends: [string, string][] = []
    if (AIRPORTS.includes(dep)) ends.push([dep, arr])
    if (AIRPORTS.includes(arr)) ends.push([arr, dep])
    if (!ends.length) continue

    let d: number | null = null
    if (l.sched_dep && l.real_dep) {
      const diff = (Date.parse(l.real_dep) - Date.parse(l.sched_dep)) / 60_000
      // A twelve-hour swing is a data error, not a delay, and one would drag a day's mean by
      // minutes.
      if (Number.isFinite(diff) && Math.abs(diff) <= 12 * 60) d = diff
    }

    for (const [home, other] of ends) {
      const b = bucket(l.flight_date, home)
      if (home === arr) b.arrivals++
      if (home === dep) b.departures++
      if (l.outcome === 'cancelled') b.cancelled++
      if (l.outcome === 'diverted')  b.diverted++
      if (l.airline_iata) b.airlines.add(l.airline_iata)
      if (other) b.routes.add(`${home}-${other}`)
      if (d !== null) { b.delays.push(d); if (d <= ON_TIME_MIN) b.onTime++ }
    }
  }

  const out = [...buckets.entries()].map(([k, b]) => {
    const [stat_date, airport_iata] = k.split('|')
    return {
      stat_date,
      airport_iata,
      arrivals:     b.arrivals,
      departures:   b.departures,
      measured:     b.delays.length,
      on_time:      b.onTime,
      avg_delay_min:    b.delays.length ? Number((b.delays.reduce((x, y) => x + y, 0) / b.delays.length).toFixed(1)) : null,
      median_delay_min: b.delays.length ? Number((median(b.delays) ?? 0).toFixed(1)) : null,
      cancelled:    b.cancelled,
      diverted:     b.diverted,
      airlines:     b.airlines.size,
      routes:       b.routes.size,
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

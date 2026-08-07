import { NextResponse } from 'next/server'
import { SYRIA_AIRPORTS } from '@/lib/syria-airports'

export const dynamic    = 'force-dynamic'
export const maxDuration = 60

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

// Shared list — a local copy here is how Deir ez-Zor went unreconciled.
const SYRIAN_AIRPORTS: readonly string[] = SYRIA_AIRPORTS

function unixToUtcHHMM(unix: number): string {
  const d = new Date(unix * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function unixToSyriaDow(unix: number): string {
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  // Shift to Syria local time (UTC+3) before reading the day
  const d = new Date((unix + 3 * 3600) * 1000)
  return DAYS[d.getUTCDay()]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteRow = any

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const forceDate = searchParams.get('date')

  // Yesterday in Syria time — the fr24-sync cron runs at 02:00 UTC and populates
  // yesterday's cache, so by 03:00 UTC the data is ready to reconcile.
  const yesterday = new Date(Date.now() - 24 * 3600_000)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Damascus' })
  const targetDate = forceDate ?? yesterday

  // ── 1. Load all active route_master rows with their flight numbers ──────────
  const rmRes = await fetch(
    `${SB_URL}/rest/v1/route_master` +
    `?active=eq.true` +
    `&select=id,dep_iata,arr_iata,dep_time_utc,arr_time_utc,duration_min,days_of_week,flight_lookup(iata_number,broadcast_callsign)`,
    { headers: HEADERS }
  )
  if (!rmRes.ok) {
    return NextResponse.json({ ok: false, error: `route_master fetch failed: ${rmRes.status}` }, { status: 502 })
  }
  const rmRows: RouteRow[] = await rmRes.json()

  // Build lookup: (flight_num|dep|arr|dow) → list of route_master rows
  // One flight can have multiple rows (different days, different times)
  const rmByKey = new Map<string, RouteRow[]>()
  for (const rm of rmRows) {
    const fl = rm.flight_lookup
    if (!fl) continue
    for (const dow of (rm.days_of_week ?? [])) {
      for (const num of [fl.iata_number, fl.broadcast_callsign].filter(Boolean)) {
        const key = `${num}|${rm.dep_iata}|${rm.arr_iata}|${dow}`
        if (!rmByKey.has(key)) rmByKey.set(key, [])
        rmByKey.get(key)!.push(rm)
      }
    }
  }

  // ── 2. Load yesterday's cache for Syrian airports ──────────────────────────
  const cacheRes = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache` +
    `?flight_date=eq.${targetDate}` +
    `&airport_iata=in.(${SYRIAN_AIRPORTS.join(',')})` +
    `&select=airport_iata,arrivals,departures`,
    { headers: HEADERS }
  )
  if (!cacheRes.ok) {
    return NextResponse.json({ ok: false, error: `cache fetch failed: ${cacheRes.status}` }, { status: 502 })
  }
  const cacheRows: RouteRow[] = await cacheRes.json()

  // ── 3. Compare each cache flight against route_master ──────────────────────
  const toInsert: object[] = []
  const seen = new Set<string>()

  for (const row of cacheRows) {
    const ap = row.airport_iata as string

    const flights: RouteRow[] = [
      ...(row.arrivals   ?? []).map((f: RouteRow) => ({ ...f, arr_iata: f.arr_iata || ap })),
      ...(row.departures ?? []).map((f: RouteRow) => ({ ...f, dep_iata: f.dep_iata || ap })),
    ]

    for (const f of flights) {
      const num = (f.num ?? '').trim()
      const dep = (f.dep_iata ?? '').trim()
      const arr = (f.arr_iata ?? '').trim()
      if (!num || !dep || !arr || !f.sched_dep) continue
      if (!SYRIAN_AIRPORTS.includes(dep) && !SYRIAN_AIRPORTS.includes(arr)) continue

      // Deduplicate: same flight can appear in both the Syrian arrival and
      // the origin airport's departure cache on the same date.
      const dedupeKey = `${num}|${dep}|${arr}|${targetDate}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      const cacheDep  = unixToUtcHHMM(f.sched_dep)
      const cacheArr  = f.sched_arr ? unixToUtcHHMM(f.sched_arr) : null
      const cacheDur  = f.duration_min ?? null
      const dow       = unixToSyriaDow(f.sched_dep)

      const candidates = rmByKey.get(`${num}|${dep}|${arr}|${dow}`) ?? []

      if (candidates.length === 0) {
        toInsert.push({
          flight_date:     targetDate,
          iata_number:     num,
          dep_iata:        dep,
          arr_iata:        arr,
          sched_dep_utc:   cacheDep,
          sched_arr_utc:   cacheArr,
          duration_min:    cacheDur,
          day_of_week:     dow,
          route_master_id: null,
          rm_dep_time_utc: null,
          rm_arr_time_utc: null,
          diff_minutes:    null,
          reason:          'new_route',
        })
        continue
      }

      // Find the best-matching route_master row (smallest dep-time difference)
      const cacheDepMin = hhmmToMin(cacheDep)
      let best: RouteRow = candidates[0]
      let bestDiff = Infinity
      for (const c of candidates) {
        if (!c.dep_time_utc) continue
        const rmMin = hhmmToMin(c.dep_time_utc.slice(0, 5))
        // Midnight-crossing guard: 23:55 vs 00:05 = 10 min, not 1430
        const diff = Math.min(
          Math.abs(cacheDepMin - rmMin),
          1440 - Math.abs(cacheDepMin - rmMin)
        )
        if (diff < bestDiff) { bestDiff = diff; best = c }
      }

      if (bestDiff > 10) {
        toInsert.push({
          flight_date:     targetDate,
          iata_number:     num,
          dep_iata:        dep,
          arr_iata:        arr,
          sched_dep_utc:   cacheDep,
          sched_arr_utc:   cacheArr,
          duration_min:    cacheDur,
          day_of_week:     dow,
          route_master_id: best.id,
          rm_dep_time_utc: best.dep_time_utc?.slice(0, 5) ?? null,
          rm_arr_time_utc: best.arr_time_utc?.slice(0, 5) ?? null,
          diff_minutes:    bestDiff,
          reason:          'time_drift',
        })
      }
    }
  }

  // ── 4. Write to unfiled_flights (ignore duplicate date+flight+reason rows) ─
  let inserted = 0
  if (toInsert.length > 0) {
    const insRes = await fetch(`${SB_URL}/rest/v1/unfiled_flights`, {
      method: 'POST',
      headers: {
        ...HEADERS,
        'Content-Type': 'application/json',
        Prefer:         'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(toInsert),
    })
    if (!insRes.ok) {
      const err = await insRes.text()
      console.error('[route-reconcile] insert failed:', err)
      return NextResponse.json({ ok: false, error: err }, { status: 502 })
    }
    inserted = toInsert.length
  }

  return NextResponse.json({
    ok: true,
    date:      targetDate,
    checked:   seen.size,
    flagged:   toInsert.length,
    inserted,
    breakdown: {
      time_drift: toInsert.filter((r: object) => (r as { reason: string }).reason === 'time_drift').length,
      new_route:  toInsert.filter((r: object) => (r as { reason: string }).reason === 'new_route').length,
    },
  })
}

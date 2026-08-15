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

  // Yesterday in Syria time.
  //
  // This said the fr24-sync cron populated yesterday's cache at 02:00 UTC, so 03:00 was safe.
  // fr24-sync was never in vercel.json and never ran; it was removed on 15 Aug. So the cache
  // this reads is filled only by whoever opens /fr24 in a browser, and the freshness this job
  // assumes has never existed. It needs repointing at `flight`, which the harvester keeps
  // current — until then its input is as complete as yesterday's audience happened to be.
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

  // ── 2. Load yesterday's flights for Syrian airports ────────────────────────
  /*
   * `flight`, not fr24_daily_cache.
   *
   * The cache is filled only by whoever opens /fr24 in a browser — cron/fr24-sync was never in
   * vercel.json and was removed on 15 Aug — so a route that operated on a quiet night was
   * invisible here, and reconciliation was as complete as yesterday's audience happened to be.
   * `flight` is written by the harvester on its own schedule and holds one row per leg.
   *
   * The comparison below is unchanged. Only the source and the field shapes differ: the cache
   * carried per-airport JSONB arrays with unix seconds, `flight` carries timestamps, so the two
   * schedule times are converted back to unix and everything downstream reads the same.
   */
  const syrianList = SYRIAN_AIRPORTS.join(',')
  const flightRes = await fetch(
    `${SB_URL}/rest/v1/flight` +
    `?flight_date=eq.${targetDate}` +
    `&or=(dep_iata.in.(${syrianList}),arr_iata.in.(${syrianList}))` +
    `&select=iata_number,callsign,dep_iata,arr_iata,sched_dep,sched_arr,duration_min`,
    { headers: HEADERS }
  )
  if (!flightRes.ok) {
    return NextResponse.json({ ok: false, error: `flight fetch failed: ${flightRes.status}` }, { status: 502 })
  }
  const flightRows: RouteRow[] = await flightRes.json()

  // ── 3. Compare each flight against route_master ────────────────────────────
  const toInsert: object[] = []
  const seen = new Set<string>()

  for (const f of flightRows) {
    const dep = (f.dep_iata ?? '').trim()
    const arr = (f.arr_iata ?? '').trim()
    const depMs = Date.parse(f.sched_dep ?? '')
    if (!dep || !arr || !Number.isFinite(depMs)) continue
    if (!SYRIAN_AIRPORTS.includes(dep) && !SYRIAN_AIRPORTS.includes(arr)) continue

    /*
     * Either identifier will match. route_master is indexed above under both the IATA number and
     * the broadcast callsign, and which one a route is filed under varies by carrier — the same
     * XH744 / FYC744 split that has caused silent misses all week. Whichever finds candidates
     * wins; the unfiled row is still written under the IATA number, as it always was.
     */
    const num = (f.iata_number ?? '').trim()
    const cs  = (f.callsign ?? '').trim()
    if (!num && !cs) continue

    // `flight` holds one row per leg, so the cross-airport duplicate the cache produced cannot
    // occur — the guard stays because it costs nothing and the key is still meaningful.
    const dedupeKey = `${num || cs}|${dep}|${arr}|${targetDate}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const sched_dep = Math.floor(depMs / 1000)
    const arrMs     = Date.parse(f.sched_arr ?? '')
    const sched_arr = Number.isFinite(arrMs) ? Math.floor(arrMs / 1000) : null

    const cacheDep  = unixToUtcHHMM(sched_dep)
    const cacheArr  = sched_arr ? unixToUtcHHMM(sched_arr) : null
    const cacheDur  = f.duration_min ?? null
    const dow       = unixToSyriaDow(sched_dep)

    const candidates = (num ? rmByKey.get(`${num}|${dep}|${arr}|${dow}`) : undefined)
                    ?? (cs  ? rmByKey.get(`${cs}|${dep}|${arr}|${dow}`)  : undefined)
                    ?? []

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

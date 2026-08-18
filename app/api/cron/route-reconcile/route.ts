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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteRow = any

/**
 * The route_master row whose scheduled departure is nearest, and by how many minutes.
 *
 * Three branches below need this and all three need the same midnight-crossing guard, which is the
 * kind of thing that gets copied twice and fixed once.
 */
function closestByDep(rows: RouteRow[], depMin: number): { row: RouteRow | null; diff: number } {
  let row: RouteRow | null = null
  let diff = Infinity
  for (const c of rows) {
    if (!c.dep_time_utc) continue
    // slice(0,5): route_master stores HH:MM:SS, hhmmToMin reads HH:MM.
    const rmMin = hhmmToMin(c.dep_time_utc.slice(0, 5))
    // 23:55 against 00:05 is 10 minutes apart, not 1430.
    const d = Math.min(Math.abs(depMin - rmMin), 1440 - Math.abs(depMin - rmMin))
    if (d < diff) { diff = d; row = c }
  }
  return { row, diff }
}

function unixToSyriaDow(unix: number): string {
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  // Shift to Syria local time (UTC+3) before reading the day
  const d = new Date((unix + 3 * 3600) * 1000)
  return DAYS[d.getUTCDay()]
}

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

  /*
   * A second index, WITHOUT the flight number: (dep|arr|dow) → rows.
   *
   * A route already filed can operate under a different number. Sundair flew the Saturday Berlin
   * service as SDR16GL/SDR17HL on 15 Aug rather than its filed SDR196/SDR197 — same route, same
   * times, same day, same airline. Keyed on the number alone that reads as a brand-new route, and
   * applying it created a second route_master row identical to the one already there, so the
   * destinations page listed Berlin twice.
   *
   * This index is what tells the two apart: no number match, but something else already flies
   * this pairing at this time on this day, so it is an alias rather than a discovery.
   */
  const rmByRoute = new Map<string, RouteRow[]>()
  for (const rm of rmRows) {
    for (const dow of (rm.days_of_week ?? [])) {
      const key = `${rm.dep_iata}|${rm.arr_iata}|${dow}`
      if (!rmByRoute.has(key)) rmByRoute.set(key, [])
      rmByRoute.get(key)!.push(rm)
    }
  }

  /*
   * A third index, this time WITHOUT the day: (flight_num|dep|arr) → rows.
   *
   * The same mistake as the alias one, in the other dimension. An airline that adds a weekday to a
   * route it already flies keeps its number and its pairing and changes only the day — and because
   * the first index is keyed on the day, that finds nothing and reads as a discovery. XH743
   * DAM->SHJ was filed fri,sat at 21:05, started running Monday and Tuesday at 21:15, and got a
   * second route_master row ten minutes away from the first: one service, two rows.
   *
   * The alias index cannot catch it, because that one matches on route and day while ignoring the
   * NUMBER — and on a brand-new day nothing else is flying the pairing either.
   */
  const rmByNumRoute = new Map<string, RouteRow[]>()
  for (const rm of rmRows) {
    const fl = rm.flight_lookup
    if (!fl) continue
    for (const num of [fl.iata_number, fl.broadcast_callsign].filter(Boolean)) {
      const key = `${num}|${rm.dep_iata}|${rm.arr_iata}`
      if (!rmByNumRoute.has(key)) rmByNumRoute.set(key, [])
      rmByNumRoute.get(key)!.push(rm)
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
    // No duration_min: `flight` has no duration column at all. Asking for one returned
    // HTTP 400 "column flight.duration_min does not exist", flightRes.ok was false, and this
    // route returned 502 before reaching the comparison — silently, on every scheduled run
    // since 15 Aug. The field came across unchanged from fr24_daily_cache, which did have it.
    // It is computed below from the two timestamps instead, which is what it always meant.
    `&select=iata_number,callsign,dep_iata,arr_iata,sched_dep,sched_arr`,
    { headers: HEADERS }
  )
  if (!flightRes.ok) {
    /*
     * Loud, because quiet is how this went unnoticed for three days.
     *
     * A 502 here is indistinguishable from a night with nothing to report: the admin page simply
     * shows no new rows either way. The body is included so the reason is in the log rather than
     * only the status.
     */
    const body = await flightRes.text().catch(() => '')
    console.error('[route-reconcile] flight fetch failed:', flightRes.status, body)
    return NextResponse.json(
      { ok: false, error: `flight fetch failed: ${flightRes.status}`, detail: body.slice(0, 300) },
      { status: 502 },
    )
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
    /*
     * Block time, computed rather than read.
     *
     * `flight` carries full timestamps, so an overnight leg's arrival is genuinely on the next
     * day and the subtraction needs no wraparound — unlike the time-only columns in route_master,
     * where 23:50 to 00:25 has to be handled explicitly.
     */
    const cacheDur  = Number.isFinite(arrMs)
      ? Math.round((arrMs - depMs) / 60000)
      : null
    const dow       = unixToSyriaDow(sched_dep)

    const candidates = (num ? rmByKey.get(`${num}|${dep}|${arr}|${dow}`) : undefined)
                    ?? (cs  ? rmByKey.get(`${cs}|${dep}|${arr}|${dow}`)  : undefined)
                    ?? []

    if (candidates.length === 0) {
      const depMin = hhmmToMin(cacheDep)

      /*
       * Before anything else: is this the SAME flight, on a day it has not flown before?
       *
       * Checked ahead of the alias branch because a number-and-route match is stronger evidence
       * than a route match alone. Reversed, XH743 on its first Monday could be claimed as an alias
       * of whatever else happens to fly DAM->SHJ on Mondays — a different airline's service — and
       * the number, the thing that actually identifies it, would be the one signal ignored.
       */
      const sameNumRoute = rmByNumRoute.get(`${num}|${dep}|${arr}`)
                        ?? (cs ? rmByNumRoute.get(`${cs}|${dep}|${arr}`) : undefined)
                        ?? []
      const near = closestByDep(sameNumRoute, depMin)

      /*
       * The 10-minute tolerance is doing real work here, not just matching the rest of the file.
       *
       * `new_day` means one action: append this day to that row's days_of_week. That is only
       * truthful if the row's departure time is also this day's departure time. XH485 DAM->SAW
       * flies 22:20 on Friday and 22:40 on Sunday; folding Sunday into the Friday row would file
       * Sunday as departing 22:20, which is wrong by twenty minutes on every board that reads it.
       *
       * So a same-number, same-route, different-day, DIFFERENT-TIME service stays `new_route`.
       * It genuinely needs its own row — that is what route_master's per-day-group rows are for.
       */
      if (near.row && near.diff <= 10) {
        toInsert.push({
          flight_date:     targetDate,
          iata_number:     num,
          dep_iata:        dep,
          arr_iata:        arr,
          sched_dep_utc:   cacheDep,
          sched_arr_utc:   cacheArr,
          duration_min:    cacheDur,
          day_of_week:     dow,
          route_master_id: near.row.id,
          rm_dep_time_utc: near.row.dep_time_utc?.slice(0, 5) ?? null,
          rm_arr_time_utc: near.row.arr_time_utc?.slice(0, 5) ?? null,
          diff_minutes:    near.diff,
          reason:          'new_day',
          // Present on every branch: PostgREST rejects a bulk insert whose objects do not
          // all carry the same keys (PGRST102), so the alias branch's flag has to exist here
          // too. Caught by a local run; in production it would have been another silent 502.
          reviewed:        false,
        })
        continue
      }

      /*
       * Nothing matches this NUMBER — but does anything already fly this route, this day, at this
       * time? If so it is the same service under another name, not a new one.
       *
       * Filed as `alias` with the row it duplicates attached, so the admin page can offer the
       * action that is actually correct: teach flight_lookup the alternative number, rather than
       * create a route that already exists.
       */
      const sameRoute = rmByRoute.get(`${dep}|${arr}|${dow}`) ?? []
      const { row: aliasOf, diff: aliasDiff } = closestByDep(sameRoute, depMin)

      if (aliasOf && aliasDiff <= 10) {
        toInsert.push({
          flight_date:     targetDate,
          iata_number:     num,
          dep_iata:        dep,
          arr_iata:        arr,
          sched_dep_utc:   cacheDep,
          sched_arr_utc:   cacheArr,
          duration_min:    cacheDur,
          day_of_week:     dow,
          route_master_id: aliasOf.id,
          rm_dep_time_utc: aliasOf.dep_time_utc,
          rm_arr_time_utc: aliasOf.arr_time_utc,
          diff_minutes:    aliasDiff,
          reason:          'alias',
          /*
           * An exact match is filed already reviewed.
           *
           * Sundair's Berlin service changes its flight number on every single operation —
           * SR16GL/SR17HL on 15 Aug, SR14ML/SR15NL on 18 Aug, letters in the suffix, never
           * repeated — while the route, both directions, both days and both times sit in
           * route_master exactly as filed. Teaching flight_lookup each number is a treadmill: the
           * next flight invents another one. Left alone it is two rows a week to dismiss by hand,
           * forever.
           *
           * Zero minutes against a route already filed carries no information, for any carrier,
           * which is why this is not special-cased to one airline. The row is still written, so
           * the Aliases tab keeps the audit trail; it simply does not ask for a decision.
           *
           * It hides nothing: if the service is ever RETIMED the number will not match and the
           * time will not match either, so it misses the alias branch entirely and surfaces as
           * new_route. Only the case with nothing to decide is silenced.
           */
          reviewed:        aliasDiff === 0,
        })
        continue
      }

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
        // Same key set as every other branch — see the note above (PGRST102).
        reviewed:        false,
      })
      continue
    }

    // The candidate whose departure is nearest. If not one of them carries a dep_time_utc there is
    // nothing to compare against, so the flight is left alone rather than filed against a row at an
    // unknown time — which is what an infinite diff used to become on the way through JSON.
    const { row: best, diff: bestDiff } = closestByDep(candidates, hhmmToMin(cacheDep))

    if (best && bestDiff > 10) {
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
        // Same key set as every other branch — see the note above (PGRST102).
        reviewed:        false,
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
    breakdown: (['time_drift', 'new_route', 'alias', 'new_day'] as const).reduce(
      (acc, reason) => {
        // Counted from the list rather than hand-written, because the two that were added since
        // are exactly the ones a hand-written literal would have gone on omitting.
        acc[reason] = toInsert.filter(r => (r as { reason: string }).reason === reason).length
        return acc
      },
      {} as Record<string, number>,
    ),
  })
}

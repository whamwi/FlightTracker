import { NextResponse } from 'next/server'
import { fetchCallsignLookup, fetchIataToIcao, resolveCallsign, resolveIata } from '@/lib/callsign'
import { SYRIA_AIRPORTS_CSV, SYRIA_AIRPORT_SET } from '@/lib/syria-airports'
import { boardFromV2 } from '@/lib/board-v2'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!

const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const PREFIX_TO_IATA: Record<string, string> = {
  FYC: 'XH',
  SYR: 'RB',
  HST: 'RB',
  SXS: 'XQ',
}

function unixToUtcHHMM(unix: number | null): string {
  if (!unix) return ''
  const d = new Date(unix * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// Extract HH:MM from FR24 status text and convert Syria local (UTC+3) → UTC ISO
function extractStatusUtc(raw: string | null, operatingDate: string): string | null {
  if (!raw) return null
  const match = raw.match(/\b(\d{1,2}):(\d{2})\b/)
  if (!match) return null
  const baseMs = new Date(operatingDate + 'T00:00:00Z').getTime()
  return new Date(baseMs + (parseInt(match[1]) * 60 + parseInt(match[2]) - 180) * 60_000).toISOString()
}

function normaliseStatus(raw: string | null): string {
  if (!raw) return 'Scheduled'
  const t = raw.toLowerCase()
  if (t === 'scheduled' || t === 'scheduled*')                return 'Scheduled'
  if (t.startsWith('delayed'))                                return 'Delayed'
  if (t.startsWith('estimated') || t.startsWith('expect'))    return 'Expected'
  if (t.includes('boarding'))                                  return 'Boarding'
  if (t.includes('gate close'))                               return 'GateClosed'
  if (t.includes('departed') || t.includes('took off'))       return 'Departed'
  if (t.includes('en route') || t.includes('in flight'))      return 'En Route'
  if (t.includes('approach'))                                  return 'Approaching'
  if (t.includes('landed') || t.includes('arrived'))          return 'Arrived'
  // "Diverted to AMM" — the flight is going somewhere else entirely and will never reach
  // the destination on its ticket. Left unrecognised it fell through to Unknown, which
  // outranks nothing, so the flight kept its Departed status and both maps carried on
  // predicting it toward an airport it had already turned away from.
  if (t.includes('divert'))                                   return 'Diverted'
  if (t.includes('cancel'))                                    return 'Cancelled'
  return 'Unknown'
}


/**
 * Flights the timetable says should exist, so an unknown status is not a reason to hide them.
 *
 * FR24 marks a scheduled flight "Unknown" when it has no live information for it, and the
 * board dropped those outright as noise. Mostly they are — but not always: FYC781's Damascus–
 * Muscat sat at Unknown all Thursday evening, was filtered off the board, and then departed
 * seven hours late. The aircraft appeared on the map with no row behind it, and anyone looking
 * at Thursday saw a flight that never happened.
 *
 * route_master knows better. If our own timetable has this flight, on this weekday, at about
 * this time, then it is scheduled — so it is relabelled Scheduled rather than left Unknown.
 * Relabelling rather than exempting means both the API filter and the board's own filter pass
 * it without either needing to know about this case.
 *
 * Half an hour of tolerance: route_master times drift against FR24 by a few minutes routinely,
 * and the reconcile page exists to close exactly that gap.
 */
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const SCHEDULE_MATCH_MIN = 30

type RmRow = {
  dep_iata: string; arr_iata: string; dep_time_utc: string | null
  days_of_week: string[] | null
  flight_lookup: { iata_number: string | null; broadcast_callsign: string | null } | null
}

async function scheduledSet(date: string): Promise<Set<string>> {
  const dow = DOW[new Date(date + 'T12:00:00Z').getUTCDay()]
  const out = new Set<string>()
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/route_master?active=is.true` +
      `&select=dep_iata,arr_iata,dep_time_utc,days_of_week,flight_lookup(iata_number,broadcast_callsign)`,
      { headers: HEADERS, cache: 'no-store' },
    )
    if (!res.ok) return out
    const rows: RmRow[] = await res.json()
    for (const r of rows) {
      if (!(r.days_of_week ?? []).includes(dow)) continue
      if (!r.dep_time_utc) continue
      const [h, m] = r.dep_time_utc.slice(0, 5).split(':').map(Number)
      const mins = h * 60 + m
      for (const num of [r.flight_lookup?.iata_number, r.flight_lookup?.broadcast_callsign]) {
        if (num) out.add(`${num.toUpperCase()}|${r.dep_iata}|${r.arr_iata}|${mins}`)
      }
    }
  } catch { /* an empty set means the old behaviour: Unknown is dropped */ }
  return out
}

/** Does the timetable have this flight, this weekday, within half an hour of this time? */
function onSchedule(set: Set<string>, f: {
  iata_number?: string | null; callsign?: string | null
  dep_iata?: string | null; arr_iata?: string | null; dep_time_utc?: string | null
}): boolean {
  if (!f.dep_time_utc || !f.dep_iata || !f.arr_iata) return false
  const [h, m] = f.dep_time_utc.slice(0, 5).split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false
  const mins = h * 60 + m
  for (const num of [f.iata_number, f.callsign]) {
    if (!num) continue
    for (let d = -SCHEDULE_MATCH_MIN; d <= SCHEDULE_MATCH_MIN; d++) {
      // Wrapped, so a flight scheduled near midnight still matches across the boundary.
      const t = ((mins + d) % 1440 + 1440) % 1440
      if (set.has(`${num.toUpperCase()}|${f.dep_iata}|${f.arr_iata}|${t}`)) return true
    }
  }
  return false
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  if (!date) return NextResponse.json({ ok: false, error: 'date required' }, { status: 400 })

  const v2 = await boardFromV2(date, 'flightboard')
  if (v2) {
    return NextResponse.json(
      { ok: true, date, flights: v2, source: 'v2' },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } },
    )
  }

  // The broadcast callsign for every row. The board carried none, so the map's side panel
  // could only show the ticketed number while the map labelled the same aircraft by
  // callsign — G9434 in the panel, ABY434 on the plane beside it. Both caches are hourly and
  // shared with /api/airspace, so this costs nothing per request.
  const [lookup, iataToIcao] = await Promise.all([fetchCallsignLookup(), fetchIataToIcao()])

  // Build airline map from DB (1-hour Next.js cache)
  const alRes = await fetch(
    `${SB_URL}/rest/v1/airlines?select=iata,name_en,country_flag&order=iata`,
    { headers: HEADERS, next: { revalidate: 3600 } }
  )
  const airlineMap: Record<string, { name: string; flag: string }> = {}
  if (alRes.ok) {
    const alRows: { iata: string; name_en: string; country_flag: string | null }[] = await alRes.json()
    for (const r of alRows) airlineMap[r.iata] = { name: r.name_en, flag: r.country_flag ?? '' }
  }

  // Only fetch Syrian airport rows — origin-airport caches (IST, DXB…) are excluded;
  // they bloated the response to 2950 flights and added no unique data for the board.
  const syriaCodes = SYRIA_AIRPORTS_CSV
  const cacheRes = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${date}&airport_iata=in.(${syriaCodes})&select=airport_iata,arrivals,departures`,
    { headers: HEADERS }
  )

  if (!cacheRes.ok) {
    return NextResponse.json({ ok: false, error: `cache fetch failed: ${cacheRes.status}` }, { status: 502 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cacheRows: any[] = await cacheRes.json()

  // Damascus-day bounds — flights arriving at Syrian airports must land within this window.
  const dayStartMs = new Date(date + 'T00:00:00+03:00').getTime()
  const dayEndMs   = dayStartMs + 24 * 60 * 60 * 1000
  // The shared set, not another hand-written copy. This line held its own list of three and
  // silently dropped every Deir ez-Zor flight: the cache above was fetched for DEZ, then
  // addFlight discarded each row because neither end looked Syrian.
  const SYRIAN_AIRPORTS = SYRIA_AIRPORT_SET

  // Status priority: higher rank wins when the same flight appears in multiple airport caches.
  const STATUS_RANK: Record<string, number> = {
    // Diverted ranks with Arrived: both are terminal for this flight, and a later Departed
    // or Delayed row must not pull it back to looking airborne.
    Arrived: 8, Landed: 8, Diverted: 8, Approaching: 7, 'En Route': 6,
    Departed: 5, Cancelled: 5, Delayed: 4, GateClosed: 3, Boarding: 3,
    Expected: 2, Scheduled: 1, Unknown: 0,
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flightMap: Record<string, any> = {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function addFlight(f: any, keyOverride?: string, skipArrFilter = false) {
    const num      = f.num       ?? ''
    const depIata  = f.dep_iata  ?? ''
    const arrIata  = f.arr_iata  ?? ''
    const schedDep = f.sched_dep ?? null
    const schedArr = f.sched_arr ?? null

    // Only keep flights that touch a Syrian airport
    if (!SYRIAN_AIRPORTS.has(depIata) && !SYRIAN_AIRPORTS.has(arrIata)) return

    // Drop overnight arrivals that land on a different Damascus calendar day.
    // skipArrFilter bypasses this for cross-midnight inbound flights still airborne.
    if (!skipArrFilter && arrIata && SYRIAN_AIRPORTS.has(arrIata) && schedArr) {
      const arrMs = schedArr * 1000
      if (arrMs < dayStartMs || arrMs >= dayEndMs) return
    }

    /*
     * A flight belongs to the day it was *due*, not the day it manages to land.
     *
     * This used to drop a flight from today the moment FR24's estimate slipped past Syria
     * midnight, and a third pass re-added it to tomorrow. So XH728 — due 21:50, delayed to
     * 00:05 — left today's board at exactly the hour people were looking for it and turned
     * up under Tomorrow, which nobody would think to check for a flight they watched board
     * this evening. The spill is shown instead: see arrNextDay below.
     */
    const schedArrMs  = schedArr ? schedArr * 1000 : null
    const schedIsToday = schedArrMs != null && schedArrMs >= dayStartMs && schedArrMs < dayEndMs

    // The confirmed landing still has to fall on this board's day, or a row filed under the
    // wrong date would show up twice. The one exception is the case above: due today, landed
    // after midnight. Landing *early*, before this day began, is still someone else's row.
    if (arrIata && SYRIAN_AIRPORTS.has(arrIata) && f.real_arr) {
      const actualMs = (f.real_arr as number) * 1000
      const spilled  = schedIsToday && actualMs >= dayEndMs
      if (!spilled && (actualMs < dayStartMs || actualMs >= dayEndMs)) return
    }

    const key    = keyOverride ?? `${num}|${depIata}|${arrIata}`
    const status = normaliseStatus(f.status)

    // Effective duration: actual_dep→revised_arr is more accurate than the scheduled block time.
    const effectiveDuration = (() => {
      if (f.fr24_actual_dep && f.fr24_revised_arr) {
        const computed = Math.round(
          (new Date(f.fr24_revised_arr).getTime() - new Date(f.fr24_actual_dep).getTime()) / 60_000
        )
        if (computed > 30) return computed
      }
      return f.duration_min ?? 0
    })()

    // Infer 'Arrived' when ATD + effective block time is > 15 min in the past with no FR24 confirmation yet.
    // Uses effectiveDuration (not raw duration_min) so the revised ETA drives the inference, not the padded schedule.
    const inferredArrived = !f.fr24_actual_arr
      && !!f.fr24_actual_dep
      && effectiveDuration > 0
      && new Date(f.fr24_actual_dep as string).getTime() + effectiveDuration * 60_000 < Date.now() - 15 * 60_000

    const effectiveStatus = f.fr24_actual_arr ? 'Arrived'
      : inferredArrived ? 'Arrived'
      : (f.fr24_actual_dep && (STATUS_RANK[status] ?? 0) < STATUS_RANK['Departed'] ? 'Departed' : status)

    if (flightMap[key]) {
      const existRank = STATUS_RANK[flightMap[key].status] ?? 0
      // Always take the best status seen across all entries
      if ((STATUS_RANK[effectiveStatus] ?? 0) > existRank) flightMap[key].status = effectiveStatus
      // Always overwrite timing with the latest entry (later in array = more recent FR24 data)
      if (schedDep) { flightMap[key].dep_time_utc = unixToUtcHHMM(schedDep); flightMap[key].sched_dep_unix = schedDep }
      if (schedArr) flightMap[key].arr_time_utc = unixToUtcHHMM(schedArr)
      flightMap[key].arr_next_day = flightMap[key].arr_next_day || arrNextDay(f, schedArr)
      // Prefer computed effective duration; only fall back to raw if no better value exists
      if (f.fr24_actual_dep && f.fr24_revised_arr) {
        flightMap[key].duration_min = effectiveDuration
      } else if (f.duration_min && !flightMap[key].duration_min) {
        flightMap[key].duration_min = f.duration_min
      }
      if (f.fr24_actual_dep)  flightMap[key].actual_dep_utc  = f.fr24_actual_dep
      if (f.fr24_actual_arr)  flightMap[key].actual_arr_utc  = f.fr24_actual_arr
      if (f.fr24_revised_dep) flightMap[key].revised_dep_utc = f.fr24_revised_dep
      if (f.fr24_revised_arr) flightMap[key].revised_arr_utc = f.fr24_revised_arr
      if (f.dep_terminal) flightMap[key].dep_terminal = f.dep_terminal
      if (f.dep_gate)     flightMap[key].dep_gate     = f.dep_gate
      if (f.arr_terminal) flightMap[key].arr_terminal = f.arr_terminal
      if (f.arr_gate)     flightMap[key].arr_gate     = f.arr_gate
      if (f.arr_baggage)  flightMap[key].arr_baggage  = f.arr_baggage
      return
    }

    const airlineIata = f.airline_iata || PREFIX_TO_IATA[num.slice(0, 3)] || ''
    // Reject flights from airlines not in our database — filters out FR24 noise (e.g. Taquan Air K3…)
    if (!airlineMap[airlineIata]) return
    const al = airlineMap[airlineIata]

    flightMap[key] = {
      iata_number:     resolveIata(num, lookup),
      callsign:        resolveCallsign(num, lookup, iataToIcao),
      airline_name:    al.name,
      airline_iata:    airlineIata,
      country_flag:    al.flag,
      dep_iata:        depIata,
      arr_iata:        arrIata,
      dep_time_utc:    unixToUtcHHMM(schedDep),
      arr_time_utc:    unixToUtcHHMM(schedArr),
      sched_dep_unix:  schedDep,
      duration_min:    effectiveDuration,
      status:          effectiveStatus,
      actual_dep_utc:  f.fr24_actual_dep  ?? null,
      actual_arr_utc:  f.fr24_actual_arr  ?? null,
      revised_dep_utc: f.fr24_revised_dep ?? null,
      revised_arr_utc: f.fr24_revised_arr ?? null,
      aircraft_type:   f.aircraft    ?? null,
      aircraft_reg:    f.reg         ?? null,
      dep_terminal:    f.dep_terminal ?? null,
      dep_gate:        f.dep_gate     ?? null,
      arr_terminal:    f.arr_terminal ?? null,
      arr_gate:        f.arr_gate     ?? null,
      arr_baggage:     f.arr_baggage  ?? null,
      /*
       * The arrival lands on the day after this board's. Timetables have written this as
       * +1 for decades, and it is the only honest way to show 00:05 in a column of evening
       * times without it reading as ten past midnight this morning.
       */
      arr_next_day:    arrNextDay(f, schedArr),
    }
  }

  /**
   * Whether the arrival falls on the Damascus day after this board's date.
   *
   * Measured against the time actually shown — an arrival that has landed shows its landing,
   * one that is delayed shows its estimate — so the marker never contradicts the digits it
   * sits beside.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function arrNextDay(f: any, schedArr: number | null): boolean {
    const shownMs =
      (f.real_arr ? (f.real_arr as number) * 1000 : null)
      ?? (f.est_arr ? (f.est_arr as number) * 1000 : null)
      ?? (schedArr ? schedArr * 1000 : null)
    return shownMs != null && shownMs >= dayEndMs
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function processDeparture(f: any, ap: string, d: string) {
    const t = (f.status ?? '').toLowerCase()
    addFlight({
      ...f,
      dep_iata:         f.dep_iata || ap,
      // Prefer unix timestamps — they're UTC and timezone-unambiguous.
      // extractStatusUtc assumes Syria local time (UTC+3) so it's wrong for non-Syrian origin airports.
      fr24_actual_dep:  f.real_dep
        ? new Date(f.real_dep * 1000).toISOString()
        : (t.includes('departed') || t.includes('took off') ? extractStatusUtc(f.status, d) : null),
      fr24_revised_dep: f.est_dep
        ? new Date(f.est_dep * 1000).toISOString()
        : (t.startsWith('estimated') || t.startsWith('expect') || t.startsWith('delayed') ? extractStatusUtc(f.status, d) : null),
      fr24_actual_arr: f.real_arr ? new Date(f.real_arr * 1000).toISOString() : null,
      fr24_revised_arr: f.est_arr ? new Date(f.est_arr * 1000).toISOString() : null,
    })
  }

  // Collect non-Syrian origin airports from Syrian arrival rows so we can query
  // their departure caches in a second pass — gives us "Departed" / "En Route"
  // status for flights still in the air when the destination cache says "Scheduled".
  const originSet = new Set<string>()

  for (const row of cacheRows) {
    const ap = row.airport_iata as string
    for (const f of (row.departures ?? [])) processDeparture(f, ap, date)
    for (const f of (row.arrivals ?? [])) {
      const t = (f.status ?? '').toLowerCase()
      addFlight({
        ...f,
        arr_iata:         f.arr_iata || ap,
        // Prefer unix timestamps (unambiguous UTC). extractStatusUtc anchors the parsed
        // HH:MM to operatingDate and gives the wrong day for cross-midnight flights.
        fr24_actual_arr:  f.real_arr
          ? new Date(f.real_arr * 1000).toISOString()
          : (t.includes('landed') || t.includes('arrived') ? extractStatusUtc(f.status, date) : null),
        fr24_revised_arr: f.est_arr
          ? new Date(f.est_arr * 1000).toISOString()
          : (t.startsWith('estimated') || t.startsWith('expect') || t.startsWith('delayed') ? extractStatusUtc(f.status, date) : null),
        fr24_actual_dep:  f.real_dep ? new Date(f.real_dep * 1000).toISOString() : null,
        fr24_revised_dep: f.est_dep  ? new Date(f.est_dep  * 1000).toISOString() : null,
      })
      // Collect origin for second pass
      const dep = (f.dep_iata || '') as string
      if (dep && !SYRIAN_AIRPORTS.has(dep)) originSet.add(dep)
    }
  }

  // Second pass: read departure caches from origin airports.
  // Only departures are needed (we want their outbound status toward Syria).
  if (originSet.size > 0) {
    const originCodes = [...originSet].join(',')
    const originRes = await fetch(
      `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${date}&airport_iata=in.(${originCodes})&select=airport_iata,departures`,
      { headers: HEADERS }
    )
    if (originRes.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const originRows: any[] = await originRes.json()
      for (const row of originRows) {
        const ap = row.airport_iata as string
        for (const f of (row.departures ?? [])) processDeparture(f, ap, date)
      }
    }
  }

  /*
   * The previous day's delayed arrivals used to be pulled onto this board here, paired with
   * the drop in addFlight that pushed them off their own. Both are gone: a flight stays on
   * the day it was due and carries arr_next_day when it lands after midnight.
   *
   * Removing only one of the two would have been worse than either — dropped from its own
   * board by the old rule and never re-added by this one, a delayed evening arrival would
   * have vanished from the site entirely.
   */

  // Fetch tomorrow's Syrian arrival caches once — shared by two sub-cases below.
  {
    const next = new Date(date + 'T12:00:00Z')
    next.setUTCDate(next.getUTCDate() + 1)
    const nextDate = next.toISOString().slice(0, 10)
    const nextRes = await fetch(
      `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${nextDate}&airport_iata=in.(${syriaCodes})&select=airport_iata,arrivals`,
      { headers: HEADERS }
    )
    if (nextRes.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nextRows: any[] = await nextRes.json()
      for (const row of nextRows) {
        const ap = row.airport_iata as string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const f of (row.arrivals ?? [])) {
          const arrIata = f.arr_iata || ap
          const key = `${f.num ?? ''}|${f.dep_iata ?? ''}|${arrIata}`
          if (flightMap[key]) continue

          if (f.real_arr) {
            // Case A — "Early landing": sched_arr is past Syria midnight but plane
            // actually landed within today's Syria window (real_arr < dayEndMs).
            const realMs = (f.real_arr as number) * 1000
            if (realMs < dayStartMs || realMs >= dayEndMs) continue
            addFlight({
              ...f,
              sched_arr: f.real_arr,  // use actual landing for day-assignment and sorting
              arr_iata: arrIata,
              fr24_actual_arr:  new Date(f.real_arr * 1000).toISOString(),
              fr24_actual_dep:  f.real_dep ? new Date(f.real_dep * 1000).toISOString() : null,
              fr24_revised_dep: f.est_dep  ? new Date(f.est_dep  * 1000).toISOString() : null,
              fr24_revised_arr: null,
            })
          } else {
            // Case B — "Cross-midnight inbound": a flight that is *already airborne* and
            // lands in the first 4 hours of the next Syria day. It belongs on tomorrow's
            // board by arrival date, but showing it on today's keeps it visible while it is
            // actually in the air. skipArrFilter bypasses the dayEndMs guard in addFlight.
            if (!f.sched_arr) continue
            const arrMs = (f.sched_arr as number) * 1000
            if (arrMs < dayEndMs || arrMs >= dayEndMs + 4 * 60 * 60 * 1000) continue

            // It must actually have departed. This condition was always in the comment and
            // never in the code, so a flight qualified on its arrival window alone and
            // appeared on today's board from 00:00 — FYC490 SAW→DAM showed up as
            // "Scheduled" 19 hours before its 19:25 UTC departure, while also sitting
            // correctly on tomorrow's board. Every late-evening inbound was double-listed.
            const st = (f.status ?? '').toLowerCase()
            const isAirborne = !!f.real_dep
              || /departed|took off|en route|in flight|approach/.test(st)
            if (!isAirborne) continue
            addFlight({
              ...f,
              arr_iata: arrIata,
              fr24_actual_arr:  null,
              fr24_revised_arr: f.est_arr ? new Date(f.est_arr * 1000).toISOString() : null,
              fr24_actual_dep:  f.real_dep ? new Date(f.real_dep * 1000).toISOString() : null,
              fr24_revised_dep: f.est_dep  ? new Date(f.est_dep  * 1000).toISOString() : null,
            }, undefined, true /* skipArrFilter */)
          }
        }
      }
    }
  }

  // Cross-midnight outbound pass: yesterday's Syrian departures whose scheduled arrival
  // falls after Syria midnight (21:00 UTC) into today's window — departed Thursday, still
  // en route (or just landed) after the Syria date rolled over to Friday.
  {
    const prevDep = new Date(date + 'T12:00:00Z')
    prevDep.setUTCDate(prevDep.getUTCDate() - 1)
    const prevDepDate = prevDep.toISOString().slice(0, 10)
    const prevDepRes = await fetch(
      `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${prevDepDate}&airport_iata=in.(${syriaCodes})&select=airport_iata,departures`,
      { headers: HEADERS }
    )
    if (prevDepRes.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prevDepRows: any[] = await prevDepRes.json()
      for (const row of prevDepRows) {
        const ap = row.airport_iata as string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const f of (row.departures ?? [])) {
          // Only cross-midnight flights: scheduled arrival after Syria midnight into today
          if (!f.sched_arr || f.sched_arr * 1000 <= dayStartMs) continue
          // Skip if flight already landed before today's Syria window began
          if (f.real_arr && f.real_arr * 1000 < dayStartMs) continue
          // Skip if the plane has inferably landed already (real_dep + block time > 30 min past).
          // Purpose of this pass is MAP tracking while airborne — once down, keep it on
          // yesterday's board only; don't duplicate onto today's.
          if (f.real_dep && f.sched_dep && f.sched_arr) {
            const blockMs = (f.sched_arr - f.sched_dep) * 1000
            if (f.real_dep * 1000 + blockMs < Date.now() - 30 * 60_000) continue
          }
          processDeparture(f, ap, prevDepDate)
        }
      }
    }
  }

  // Fourth pass: destination airports of Syrian departures — fetch their arrivals
  // to get precise landing timestamps for outbound flights (KK491 DAM→DUS etc.)
  // instead of relying solely on the inferredArrived heuristic.
  // Uses only unix timestamps (f.real_arr / f.est_arr) — avoids the Syria-UTC+3
  // assumption baked into extractStatusUtc which would be wrong for DUS, DXB, etc.
  {
    const destSet = new Set<string>()
    for (const entry of Object.values(flightMap)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arr = (entry as any).arr_iata as string
      if (arr && !SYRIAN_AIRPORTS.has(arr)) destSet.add(arr)
    }

    if (destSet.size > 0) {
      const destCodes = [...destSet].join(',')
      const destRes = await fetch(
        `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${date}&airport_iata=in.(${destCodes})&select=airport_iata,arrivals`,
        { headers: HEADERS }
      )
      if (destRes.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const destRows: any[] = await destRes.json()
        for (const row of destRows) {
          const ap = row.airport_iata as string
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const f of (row.arrivals ?? [])) {
            const num     = f.num      ?? ''
            const depIata = f.dep_iata ?? ''
            const arrIata = f.arr_iata || ap
            const key     = `${num}|${depIata}|${arrIata}`
            if (!flightMap[key]) continue

            const actualArr  = f.real_arr ? new Date(f.real_arr * 1000).toISOString() : null
            const revisedArr = f.est_arr  ? new Date(f.est_arr  * 1000).toISOString() : null

            if (actualArr) {
              flightMap[key].actual_arr_utc  = actualArr
              flightMap[key].revised_arr_utc = actualArr
              flightMap[key].status          = 'Arrived'
            } else if (revisedArr && !flightMap[key].actual_arr_utc) {
              flightMap[key].revised_arr_utc = revisedArr
            }
          }
        }
      }
    }
  }

  // Unknown, unless our own timetable says otherwise — see scheduledSet above.
  const scheduled = await scheduledSet(date)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const f of Object.values(flightMap) as any[]) {
    if (f.status === 'Unknown' && onSchedule(scheduled, f)) f.status = 'Scheduled'
  }

  return NextResponse.json(
    { ok: true, date, flights: Object.values(flightMap).filter((f: any) => f.status !== 'Unknown') },
    { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } }
  )
}

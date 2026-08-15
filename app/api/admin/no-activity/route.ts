import { NextResponse } from 'next/server'

/**
 * Month-end reckoning of flights that were scheduled and never flew.
 *
 * flight_no_activity records every flight the timetable promised and the day did not deliver.
 * Counting them is only half the answer, because two very different things land in that table:
 *
 *   - a real service that was cancelled on the day
 *   - a route_master row for a service that has never operated at all
 *
 * The second is our own bookkeeping, not an airline's cancellation, and it repeats on every
 * scheduled weekday forever. RB133/RB134 (Damascus–Deir ez-Zor, Wed/Sat) went into the
 * timetable on 5 Aug 2026 and had still never flown three days later — left in the same
 * bucket they would quietly inflate the figure twice a week.
 *
 * So each flight number is checked against `flight`: has it ever recorded a real departure, on
 * any date? Never means the schedule is unverified, and it is reported separately rather than
 * counted as a cancellation.
 *
 * This asked flight_signal_log until 15 Aug, which held one row per callsign per date written by
 * whichever visitor had the map open. A service that only ever flew while nobody was watching
 * looked unverified; RB445 was recorded as never having flown on a day `flight` has it departing
 * at 20:28 and landing at 22:02. The canonical table has no such gap.
 *
 * Under /api/admin, so the existing Basic auth gate covers it.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = {
  id: number
  flight_date: string
  iata_number: string
  callsign: string | null
  dep_iata: string | null
  arr_iata: string | null
  sched_dep_utc: string | null
  outcome: string | null
  resolved_at: string | null
  resolved_reason: string | null
  hours_overdue: number | null
}

export async function GET(req: Request) {
  const url   = new URL(req.url)
  // Default to the last 90 days: enough for a month-end view plus the two months either side.
  const from  = url.searchParams.get('from') ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
  const to    = url.searchParams.get('to')   ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)

  const res = await fetch(
    `${SB_URL}/rest/v1/flight_no_activity?flight_date=gte.${from}&flight_date=lte.${to}`
    + `&select=id,flight_date,iata_number,callsign,dep_iata,arr_iata,sched_dep_utc,outcome,`
    + `resolved_at,resolved_reason,hours_overdue&order=flight_date.desc`,
    { headers: HEADERS, cache: 'no-store' },
  )
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, error: `flight_no_activity ${res.status}: ${(await res.text()).slice(0, 200)}` },
      { status: 502 },
    )
  }
  const rows: Row[] = await res.json()

  // Which services have ever actually departed — the test for "this service is real".
  // Every date, not just the reporting window: a route that flew in July is still a real
  // route when it is cancelled in August.
  const sigRes = await fetch(
    `${SB_URL}/rest/v1/flight?real_dep=not.is.null&select=iata_number,callsign`,
    { headers: HEADERS, cache: 'no-store' },
  )
  const everFlown = new Set<string>()
  if (sigRes.ok) {
    for (const r of (await sigRes.json()) as any[]) {
      if (r.iata_number) everFlown.add(r.iata_number)
      if (r.callsign)    everFlown.add(r.callsign)
    }
  }

  // Either identifier will do: the register carries the IATA number and `flight` holds both.
  const hasFlown = (r: Row) =>
    everFlown.has(r.iata_number) || (!!r.callsign && everFlown.has(r.callsign))

  // Only settled verdicts are counted. A row still open is a flight the day has not finished
  // judging, and including it would move the total every time the page is refreshed.
  const missed = rows.filter(r => r.outcome === 'did_not_operate')

  const byMonth: Record<string, {
    month: string
    cancellations: number
    unverified_schedule: number
    flew_late: number
    still_open: number
  }> = {}

  for (const r of rows) {
    const m = r.flight_date.slice(0, 7)
    byMonth[m] ??= { month: m, cancellations: 0, unverified_schedule: 0, flew_late: 0, still_open: 0 }
    if (r.outcome === 'did_not_operate') {
      if (hasFlown(r)) byMonth[m].cancellations++
      else             byMonth[m].unverified_schedule++
    } else if (r.outcome === 'flew_late' || r.outcome === 'activity_appeared') {
      byMonth[m].flew_late++
    } else if (!r.outcome) {
      byMonth[m].still_open++
    }
  }

  // Which routes keep reappearing — a repeat offender with no signal is almost always a
  // timetable entry that should be corrected rather than an airline cancelling weekly.
  const byFlight: Record<string, { num: string; route: string; count: number; ever_flown: boolean; dates: string[] }> = {}
  for (const r of missed) {
    const k = r.iata_number
    byFlight[k] ??= {
      num: k,
      route: `${r.dep_iata ?? '?'}→${r.arr_iata ?? '?'}`,
      count: 0,
      ever_flown: hasFlown(r),
      dates: [],
    }
    byFlight[k].count++
    byFlight[k].dates.push(r.flight_date)
  }

  return NextResponse.json({
    ok: true,
    range: { from, to },
    months: Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month)),
    cancellations:       Object.values(byFlight).filter(f =>  f.ever_flown).sort((a, b) => b.count - a.count),
    unverified_schedule: Object.values(byFlight).filter(f => !f.ever_flown).sort((a, b) => b.count - a.count),
    rows,
  })
}

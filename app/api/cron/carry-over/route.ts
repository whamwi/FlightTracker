import { NextResponse } from 'next/server'

/**
 * Settles yesterday's silent flights on the flight row itself.
 *
 * FR24's board is day-bound. A flight scheduled at 21:15 that leaves at 04:15 the next morning
 * gets a fresh record on the new date, and the original entry stays at "Unknown" forever — so the
 * board shows a flight that appears never to have operated while the aircraft is in the air.
 * FYC781 Damascus–Muscat did exactly that on 6 August.
 *
 * This has been rewritten twice in one day and the second rewrite is the architectural one.
 *
 * It used to buy the answer from FR24, gated on flight_signal_log.airborne_at — a table written by
 * whichever visitor had the map open, so a flight that departed while nobody was watching was
 * closed as "did not fly" by default. RB445 ALP–IST on 10 Aug was recorded that way; it flew.
 *
 * Then it read `flight` and wrote the verdict into flight_no_activity — a second table holding a
 * copy of rows `flight` already had. That is the disagreement engine this whole cleanup keeps
 * finding: 17 register rows, all with a flight row behind them, 13 of them saying "unknown" in one
 * place and settled in the other, and RB445 still recorded as never having flown beside a row
 * showing its departure and arrival.
 *
 * So: one table. The verdict is stamped on the flight it is about.
 *
 *   outcome_checked_at   when we adjudicated it — the fact that we looked
 *   outcome_source       what answered
 *   outcome = 'no_show'  only when it did not operate; otherwise left alone
 *
 * All three columns already existed and had never been written to.
 *
 * The worklist is a query rather than a register, so it cannot drift out of step with the flights
 * it describes — which is precisely how the register came to disagree with `flight` about RB445.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }

/** After this long past the scheduled departure, a flight is not late — it did not fly. */
const GIVE_UP_HOURS = 12

type Flight = {
  flight_date: string
  iata_number: string
  callsign: string | null
  dep_iata: string | null
  arr_iata: string | null
  sched_dep: string | null
  real_dep: string | null
  real_arr: string | null
  outcome: string | null
  outcome_checked_at: string | null
}

function syriaDate(daysAgo = 0): string {
  return new Date(Date.now() + 3 * 3_600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10)
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const yesterday = syriaDate(1)

  /*
   * Yesterday's flights that have not been settled.
   *
   * Cancelled and diverted are excluded because they already explain themselves — flagging them
   * would be noise, which is the rule the old inventory applied too.
   */
  const res = await fetch(
    `${SB_URL}/rest/v1/flight?flight_date=eq.${yesterday}` +
    `&outcome_checked_at=is.null&outcome=not.in.(cancelled,diverted)` +
    `&select=flight_date,iata_number,callsign,dep_iata,arr_iata,sched_dep,real_dep,real_arr,outcome,outcome_checked_at`,
    { headers: HEADERS, cache: 'no-store' },
  )
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `flight fetch ${res.status}` }, { status: 502 })
  }
  const flights: Flight[] = await res.json()

  /*
   * When yesterday closed, in UTC. Syria is UTC+3, so 00:00 on the following day is 21:00 UTC.
   *
   * This is what replaces the snapshot the old inventory took at day close. A flight was silent
   * then exactly when it had no departure by this instant — so "flew late" is a comparison, not a
   * thing that had to be recorded at the time, and nothing is lost by deriving it afterwards.
   */
  const closeMs = Date.parse(`${yesterday}T21:00:00Z`)
  const now     = Date.now()

  const settled: string[] = []
  let skipped = 0

  for (const f of flights) {
    const depMs   = f.real_dep ? Date.parse(f.real_dep) : null
    const schedMs = f.sched_dep ? Date.parse(f.sched_dep) : null
    const overdueH = schedMs ? Math.round(((now - schedMs) / 3_600_000) * 10) / 10 : null

    // Departed before the day closed: an ordinary flight, nothing to settle.
    if (depMs !== null && depMs < closeMs) { skipped++; continue }

    let outcome: string | null = null
    let source  = ''

    if (depMs !== null) {
      /*
       * It flew, after its own day had ended. The outcome stays whatever the flight actually did
       * — arrived, or departed and still out — because that is true and this job has no better
       * information about it. What is recorded is that we looked and found a departure.
       */
      source = `carry_over:flew_late:${f.real_dep}`
    } else if (overdueH !== null && overdueH >= GIVE_UP_HOURS) {
      // No departure, and past the point where late becomes did-not-happen.
      outcome = 'no_show'
      source  = `carry_over:no_departure:${overdueH}h`
    } else {
      // Still inside the window: it may yet depart. Left unstamped so a later run sees it again.
      skipped++
      continue
    }

    const patch: Record<string, unknown> = {
      outcome_checked_at: new Date().toISOString(),
      outcome_source:     source,
    }
    if (outcome) patch.outcome = outcome

    const w = await fetch(
      `${SB_URL}/rest/v1/flight?flight_date=eq.${f.flight_date}` +
      `&iata_number=eq.${encodeURIComponent(f.iata_number)}` +
      `&dep_iata=eq.${f.dep_iata}&arr_iata=eq.${f.arr_iata}`,
      { method: 'PATCH', headers: { ...HEADERS, Prefer: 'return=minimal' }, body: JSON.stringify(patch) },
    )
    if (!w.ok) {
      console.error('[carry-over] stamp failed', f.iata_number, w.status, await w.text())
    }
    settled.push(`${f.iata_number} ${outcome ?? 'flew_late'}${w.ok ? '' : ' (WRITE FAILED)'}`)
  }

  return NextResponse.json({ ok: true, date: yesterday, examined: flights.length, skipped, settled })
}

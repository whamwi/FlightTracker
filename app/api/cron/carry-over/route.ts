import { NextResponse } from 'next/server'

/**
 * Gives yesterday's silent flights a verdict, from what v2 already knows.
 *
 * FR24's board is day-bound. A flight scheduled at 21:15 that leaves at 04:15 the next morning
 * gets a fresh record on the new date, and the original entry stays at "Unknown" forever — so the
 * board shows a flight that appears never to have operated while the aircraft is in the air.
 * FYC781 Damascus–Muscat did exactly that on 6 August.
 *
 * The first version of this answered that question by asking FR24 directly, gated on
 * flight_signal_log.airborne_at so nothing was spent while nothing moved. Two problems, both
 * settled by measurement on 15 Aug:
 *
 *   The gate depended on an audience. flight_signal_log was written by whichever visitor had the
 *   map open, so a flight that departed while nobody was watching left no signal, spent no credit,
 *   and was closed as "did not fly" by default. RB445 ALP–IST on 10 Aug was recorded that way. It
 *   flew: `flight` has real_dep 20:28:14, real_arr 22:02:21, outcome arrived.
 *
 *   The answer was already here. The harvester polls FR24 continuously and writes the canonical
 *   row, so by the time this cron runs, `flight` holds the departure and arrival it was about to
 *   pay for. Of seventeen verdicts on the board, one was wrong and the tape had the truth for it.
 *
 * So this now reads `flight` and spends nothing. No FR24 call, no signal table, and no
 * real_dep_synced / real_arr_synced bookkeeping — those existed only to stop the credit path
 * running twice, and there is no credit path.
 *
 * It also no longer writes into fr24_daily_cache. The times it used to copy there are already on
 * the `flight` row it just read; copying them into the retiring table only created a second place
 * for them to disagree.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }

/** After this long past the scheduled departure, a flight is not late — it did not fly. */
const GIVE_UP_HOURS = 12

type Open = {
  id: number
  flight_date: string
  iata_number: string
  callsign: string | null
  dep_iata: string | null
  arr_iata: string | null
  sched_dep_utc: string | null
  sched_arr_utc: string | null
}

type Canonical = {
  flight_date: string
  iata_number: string
  callsign: string | null
  dep_iata: string | null
  arr_iata: string | null
  real_dep: string | null
  real_arr: string | null
  outcome: string | null
}

function syriaDate(daysAgo = 0): string {
  return new Date(Date.now() + 3 * 3_600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10)
}

/** "HH:MM" UTC on a given date → unix ms. */
function schedMs(date: string, hhmm: string | null): number | null {
  if (!hhmm) return null
  const t = Date.parse(`${date}T${hhmm.slice(0, 5)}:00Z`)
  return Number.isFinite(t) ? t : null
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const yesterday = syriaDate(1)

  // 1. What is still open from yesterday.
  const openRes = await fetch(
    `${SB_URL}/rest/v1/flight_no_activity?flight_date=eq.${yesterday}&resolved_at=is.null` +
    `&select=id,flight_date,iata_number,callsign,dep_iata,arr_iata,sched_dep_utc,sched_arr_utc`,
    { headers: HEADERS, cache: 'no-store' },
  )
  if (!openRes.ok) {
    return NextResponse.json(
      { ok: false, error: `open fetch ${openRes.status}` }, { status: 502 })
  }
  const open: Open[] = await openRes.json()
  if (!open.length) return NextResponse.json({ ok: true, open: 0, resolved: [] })

  /*
   * 2. What the canonical table says about them. One request for the whole set.
   *
   * Matched on the flight number rather than the callsign, because flight_no_activity carries the
   * IATA form and `flight` holds both — and the pair has been a source of silent misses all week.
   * The endpoints are compared afterwards so a number operating two legs the same day resolves
   * against its own leg.
   */
  const nums = [...new Set(open.map(o => o.iata_number).filter(Boolean))]
  const canonRes = await fetch(
    `${SB_URL}/rest/v1/flight?flight_date=eq.${yesterday}` +
    `&iata_number=in.(${nums.map(encodeURIComponent).join(',')})` +
    `&select=flight_date,iata_number,callsign,dep_iata,arr_iata,real_dep,real_arr,outcome`,
    { headers: HEADERS, cache: 'no-store' },
  )
  const canon: Canonical[] = canonRes.ok ? await canonRes.json() : []

  const match = (row: Open): Canonical | undefined => {
    const mine = canon.filter(c => c.iata_number === row.iata_number)
    return mine.find(c => c.dep_iata === row.dep_iata && c.arr_iata === row.arr_iata) ?? mine[0]
  }

  const now = Date.now()
  const resolved: string[] = []

  for (const row of open) {
    const f       = match(row)
    const depMs   = schedMs(row.flight_date, row.sched_dep_utc)
    const overdue = depMs ? (now - depMs) / 3_600_000 : 0
    const overdueH = Math.round(overdue * 10) / 10

    let outcome: 'flew_late' | 'did_not_operate' | null = null
    let reason  = ''

    if (f?.real_dep) {
      /*
       * It flew. The row exists because nothing was published inside the window it was expected
       * in — not because the aircraft stayed on the ground, and the month-end count depends on
       * telling those apart.
       */
      outcome = 'flew_late'
      reason  = `departed ${f.real_dep}`
        + (f.real_arr ? `, landed ${f.real_arr}` : ' — no arrival published')
    } else if (f?.outcome === 'cancelled') {
      // FR24's own word, which is better than inferring from silence.
      outcome = 'did_not_operate'
      reason  = `cancelled${depMs ? ` — ${overdueH}h past scheduled departure` : ''}`
    } else if (overdue >= GIVE_UP_HOURS) {
      outcome = 'did_not_operate'
      reason  = `no departure recorded ${overdueH}h past scheduled departure`
    }

    // Still inside the window and nothing published yet: leave it open, it may yet depart.
    if (!outcome) continue

    const res = await fetch(`${SB_URL}/rest/v1/flight_no_activity?id=eq.${row.id}`, {
      method: 'PATCH', headers: { ...HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify({
        resolved_at: new Date().toISOString(),
        outcome,
        resolved_reason: reason,
        hours_overdue: overdueH,
      }),
    })
    if (!res.ok) {
      console.error('[carry-over] verdict write failed', row.iata_number, res.status, await res.text())
    }
    resolved.push(`${row.iata_number} ${outcome}${res.ok ? '' : ' (WRITE FAILED)'}`)
  }

  return NextResponse.json({
    ok: true,
    open:     open.length,
    canonical: canon.length,
    resolved,
  })
}

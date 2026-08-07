import { NextResponse } from 'next/server'

/**
 * Finds yesterday's flights that were scheduled and then did nothing.
 *
 * A flight with no departure and no arrival is the one case the board cannot express. FR24
 * leaves it at "Unknown" indefinitely, so the entry sits there looking like a timetable line
 * that quietly never happened — and until today's change it was filtered off the board
 * entirely. FYC781's Thursday Damascus–Muscat did exactly that, then departed at 04:15 the
 * next morning, seven hours late, on a record nobody was watching.
 *
 * Two different things are caught, and the difference is the point:
 *
 *   - a flight that later departs very late, usually across midnight. It resolves, and the
 *     row becomes evidence of how often that happens.
 *   - a flight that genuinely did not operate. It never resolves, and that is worth knowing
 *     before a passenger asks why.
 *
 * The inventory is taken at 00:15 Damascus, as the day closes: every flight scheduled that day
 * is due by then, and nothing has to be guessed about whether it is merely early. A second
 * pass at midday resolves anything that has since moved — a flight that departs at 04:15 is
 * very late, not missing, and the row should say so.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }

const SELF = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.flysyria.app'

/*
 * There is no overdue threshold.
 *
 * An earlier version skipped anything less than three hours past its scheduled departure,
 * which made sense while the check ran mid-morning against a day still in progress. The
 * inventory is now taken at 00:15 Damascus, just after the day closes, so every flight in it
 * is due by definition — and a flight scheduled at 23:50 would have been the one most likely
 * to slip past midnight and the one that threshold would have missed.
 */

/** Statuses that already explain the absence; flagging them would be noise. */
const EXPLAINED = new Set(['Cancelled', 'Diverted'])

type Board = {
  iata_number: string
  callsign: string | null
  dep_iata: string | null
  arr_iata: string | null
  dep_time_utc: string | null
  arr_time_utc: string | null
  sched_dep_unix: number | null
  status: string
  actual_dep_utc: string | null
  actual_arr_utc: string | null
}

/** Syria-local date, offset by whole days. */
function syriaDate(daysAgo = 0): string {
  return new Date(Date.now() + 3 * 3_600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10)
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const date = new URL(req.url).searchParams.get('date') ?? syriaDate(1)

  const res = await fetch(`${SELF}/api/flightboard?date=${date}`, { cache: 'no-store' })
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `flightboard ${res.status}` }, { status: 502 })
  }
  const flights: Board[] = (await res.json()).flights ?? []

  const now = Date.now()
  const idle: Record<string, unknown>[] = []
  const active = new Set<string>()

  for (const f of flights) {
    if (!f.iata_number) continue
    const key = `${f.iata_number}|${f.dep_iata ?? ''}|${f.arr_iata ?? ''}`

    if (f.actual_dep_utc || f.actual_arr_utc || EXPLAINED.has(f.status)) {
      active.add(key)
      continue
    }

    // Recorded whether or not a scheduled departure time is available. Arrivals into Syria
    // are half the board and are just as much "supposed to happen yesterday" as departures;
    // requiring a departure timestamp quietly excluded any row that lacked one.
    const schedMs = f.sched_dep_unix ? f.sched_dep_unix * 1000 : null
    const hours   = schedMs ? Math.round(((now - schedMs) / 3_600_000) * 10) / 10 : null

    idle.push({
      flight_date:   date,
      iata_number:   f.iata_number,
      callsign:      f.callsign ?? null,
      dep_iata:      f.dep_iata ?? null,
      arr_iata:      f.arr_iata ?? null,
      sched_dep_utc: f.dep_time_utc ?? null,
      sched_arr_utc: f.arr_time_utc ?? null,
      status:        f.status,
      hours_overdue: hours,
    })
  }

  /*
   * Checked, not fire-and-forget.
   *
   * The table was created with RLS on and no policy, so every insert was refused while the run
   * reported success — for a whole day this read as "the cron never fired" when it had fired,
   * been rejected, and said nothing. A recorder that cannot tell a refused write from a
   * successful one is worse than no recorder, because absence looks like good news.
   */
  let written = 0
  let writeError: string | null = null
  if (idle.length) {
    const res = await fetch(`${SB_URL}/rest/v1/flight_no_activity`, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(idle),
    })
    if (res.ok) {
      written = idle.length
    } else {
      writeError = `${res.status} ${(await res.text()).slice(0, 200)}`
      console.error('[no-activity] insert failed', writeError)
    }
  }

  /*
   * Close anything that has since moved.
   *
   * The early run flags a flight that is merely very late; the aircraft then departs and the
   * row should say so rather than sitting open as if the flight never operated. Resolving is
   * what turns this table from a list of complaints into a measurement.
   */
  let resolved = 0
  if (active.size) {
    const openRes = await fetch(
      `${SB_URL}/rest/v1/flight_no_activity?flight_date=eq.${date}&resolved_at=is.null&select=id,iata_number,dep_iata,arr_iata`,
      { headers: HEADERS, cache: 'no-store' },
    )
    const open: { id: number; iata_number: string; dep_iata: string | null; arr_iata: string | null }[] =
      openRes.ok ? await openRes.json() : []
    const ids = open
      .filter(o => active.has(`${o.iata_number}|${o.dep_iata ?? ''}|${o.arr_iata ?? ''}`))
      .map(o => o.id)
    if (ids.length) {
      const res = await fetch(`${SB_URL}/rest/v1/flight_no_activity?id=in.(${ids.join(',')})`, {
        method: 'PATCH', headers: { ...HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({
          resolved_at: new Date().toISOString(),
          resolved_reason: 'activity appeared after flagging',
        }),
      })
      if (res.ok) resolved = ids.length
      else {
        writeError = writeError ?? `resolve ${res.status} ${(await res.text()).slice(0, 200)}`
        console.error('[no-activity] resolve failed', writeError)
      }
    }
  }

  return NextResponse.json({
    ok: !writeError, date, checked: flights.length,
    flagged: idle.length, written, resolved, error: writeError,
    flights: idle.map(f => `${f.iata_number} ${f.dep_iata}→${f.arr_iata} +${f.hours_overdue}h`),
  })
}

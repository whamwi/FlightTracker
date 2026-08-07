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
 * Runs twice: once early, to catch the overnight cases while they are still moving, and once
 * later, by which time anything unresolved almost certainly did not fly.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }

const SELF = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.flysyria.app'

/**
 * A flight is not judged until this long after its scheduled departure.
 *
 * Below it, "no activity" usually means the timetable is simply ahead of the aircraft — the
 * board is full of flights that have not left yet and are perfectly fine.
 */
const OVERDUE_HOURS = 3

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

    // Scheduled departure, needed both to judge whether it is overdue and to record by how
    // much. Without one there is nothing to measure against, so it is left alone.
    const schedMs = f.sched_dep_unix ? f.sched_dep_unix * 1000 : null
    if (!schedMs) continue
    const hours = (now - schedMs) / 3_600_000
    if (hours < OVERDUE_HOURS) continue

    idle.push({
      flight_date:   date,
      iata_number:   f.iata_number,
      callsign:      f.callsign ?? null,
      dep_iata:      f.dep_iata ?? null,
      arr_iata:      f.arr_iata ?? null,
      sched_dep_utc: f.dep_time_utc ?? null,
      sched_arr_utc: f.arr_time_utc ?? null,
      status:        f.status,
      hours_overdue: Math.round(hours * 10) / 10,
    })
  }

  if (idle.length) {
    await fetch(`${SB_URL}/rest/v1/flight_no_activity`, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(idle),
    })
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
      await fetch(`${SB_URL}/rest/v1/flight_no_activity?id=in.(${ids.join(',')})`, {
        method: 'PATCH', headers: { ...HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({
          resolved_at: new Date().toISOString(),
          resolved_reason: 'activity appeared after flagging',
        }),
      })
      resolved = ids.length
    }
  }

  return NextResponse.json({
    ok: true, date, checked: flights.length, flagged: idle.length, resolved,
    flights: idle.map(f => `${f.iata_number} ${f.dep_iata}→${f.arr_iata} +${f.hours_overdue}h`),
  })
}

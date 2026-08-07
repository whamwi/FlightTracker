import { NextResponse } from 'next/server'
import { SYRIA_AIRPORT_SET } from '@/lib/syria-airports'

/**
 * Chases yesterday's flights that were still on the ground at midnight.
 *
 * FR24's board is day-bound. A flight scheduled at 21:15 that leaves at 04:15 the next morning
 * gets a fresh record on the new date with no scheduled time, and the original entry stays at
 * "Unknown" forever — so the board shows a flight that appears never to have operated, while
 * the aircraft is in the air. FYC781 Damascus–Muscat did exactly that on 6 August.
 *
 * The signal we need is already being recorded. flight_signal_log holds one row per callsign
 * per date with airborne_at, and for FYC781 it read 04:16:25 against FR24's own 04:14 — two
 * minutes, and better than anything inferred from position. Nothing was consuming it.
 *
 * So: when a carried-over flight shows a signal today, ask FR24 by callsign what actually
 * happened. flight-summary/light costs about 1.5 credits, against 38 for the full board sweep
 * that was running every two hours and could not answer this question at all.
 *
 * Two calls per flight, no more:
 *   1. once a signal appears — gets the real departure
 *   2. once the flight should have landed — gets the real arrival
 *
 * Nothing is spent while nothing moves, which is most of the time. real_dep_synced and
 * real_arr_synced on flight_signal_log are what keep it to two; they existed unused.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const SB_URL     = process.env.SUPABASE_URL!
const SB_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!
const HEADERS    = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }
const FR24_TOKEN = process.env.FR24_API_KEY!

/** After this long past the scheduled departure, a flight is not late — it did not fly. */
const GIVE_UP_HOURS = 12

/** Grace after the expected arrival before asking whether it landed. */
const ARRIVAL_GRACE_MIN = 20

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

type Signal = {
  callsign: string
  flight_date: string
  airborne_at: string | null
  last_seen_at: string | null
  real_dep_synced: boolean
  real_arr_synced: boolean
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function syriaDate(daysAgo = 0): string {
  return new Date(Date.now() + 3 * 3_600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10)
}

/** "HH:MM" UTC on a given date → unix seconds. */
function toUnix(date: string, hhmm: string | null): number | null {
  if (!hhmm) return null
  const t = Date.parse(`${date}T${hhmm.slice(0, 5)}:00Z`)
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

/**
 * Write a real departure or arrival onto the row it belongs to — yesterday's, not today's.
 *
 * The Syrian end of the flight is the one whose board we hold, so a departure lands on the
 * departure airport's row and an arrival on the arrival airport's. Anything else would be
 * writing to a board we do not have.
 */
async function writeActual(
  airport: string, date: string, num: string,
  field: 'real_dep' | 'real_arr', value: number,
): Promise<boolean> {
  const res = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache?airport_iata=eq.${airport}&flight_date=eq.${date}&select=arrivals,departures`,
    { headers: HEADERS, cache: 'no-store' },
  )
  if (!res.ok) return false
  const rows: any[] = await res.json()
  if (!rows.length) return false

  const patch = (list: any[]) =>
    (list ?? []).map((f: any) => (f.num === num ? { ...f, [field]: value } : f))

  const body = {
    airport_iata: airport,
    flight_date:  date,
    arrivals:     patch(rows[0].arrivals),
    departures:   patch(rows[0].departures),
  }
  const put = await fetch(`${SB_URL}/rest/v1/fr24_daily_cache`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  })
  return put.ok
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const yesterday = syriaDate(1)
  const today     = syriaDate(0)
  const nowSec    = Math.floor(Date.now() / 1000)

  // 1. What is still open from yesterday.
  const openRes = await fetch(
    `${SB_URL}/rest/v1/flight_no_activity?flight_date=eq.${yesterday}&resolved_at=is.null` +
    `&select=id,flight_date,iata_number,callsign,dep_iata,arr_iata,sched_dep_utc,sched_arr_utc`,
    { headers: HEADERS, cache: 'no-store' },
  )
  const open: Open[] = openRes.ok ? await openRes.json() : []
  if (!open.length) return NextResponse.json({ ok: true, open: 0, called: 0 })

  // 2. Which of them have been seen in the air today. This is the gate that keeps the credit
  //    spend at zero on a quiet night.
  const callsigns = [...new Set(open.map(o => o.callsign ?? o.iata_number).filter(Boolean))]
  const sigRes = await fetch(
    `${SB_URL}/rest/v1/flight_signal_log?flight_date=eq.${today}` +
    `&callsign=in.(${callsigns.map(encodeURIComponent).join(',')})&select=*`,
    { headers: HEADERS, cache: 'no-store' },
  )
  const signals: Signal[] = sigRes.ok ? await sigRes.json() : []
  const byCallsign = new Map(signals.map(s => [s.callsign, s]))

  type Want = { row: Open; sig: Signal; need: 'dep' | 'arr' }
  const wanted: Want[] = []

  for (const row of open) {
    const cs  = row.callsign ?? row.iata_number
    const sig = byCallsign.get(cs)
    if (!sig || !sig.airborne_at) continue

    // Give up rather than chase something that plainly did not fly.
    const schedDep = toUnix(row.flight_date, row.sched_dep_utc)
    if (schedDep && nowSec - schedDep > GIVE_UP_HOURS * 3600) continue

    if (!sig.real_dep_synced) { wanted.push({ row, sig, need: 'dep' }); continue }

    // The arrival only exists once the flight has had time to land. Asking earlier spends a
    // credit on an answer that is not there yet.
    if (!sig.real_arr_synced) {
      const airborneMs = Date.parse(sig.airborne_at)
      const schedArr   = toUnix(row.flight_date, row.sched_arr_utc)
      const schedDepS  = schedDep ?? null
      const blockMin   = schedArr && schedDepS ? (schedArr - schedDepS) / 60 : 240
      const dueMs      = airborneMs + (blockMin + ARRIVAL_GRACE_MIN) * 60_000
      if (Date.now() >= dueMs) wanted.push({ row, sig, need: 'arr' })
    }
  }

  if (!wanted.length) {
    return NextResponse.json({ ok: true, open: open.length, signals: signals.length, called: 0 })
  }

  // 3. One FR24 call for everything wanted, by callsign.
  const nums = [...new Set(wanted.map(w => w.row.callsign ?? w.row.iata_number))]
  const from = new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 19)
  const to   = new Date().toISOString().slice(0, 19)
  const url  = `https://fr24api.flightradar24.com/api/flight-summary/light`
    + `?callsigns=${encodeURIComponent(nums.join(','))}`
    + `&flight_datetime_from=${encodeURIComponent(from)}`
    + `&flight_datetime_to=${encodeURIComponent(to)}&limit=200`

  const fr = await fetch(url, {
    headers: { Authorization: `Bearer ${FR24_TOKEN}`, Accept: 'application/json', 'Accept-Version': 'v1' },
  })
  if (!fr.ok) {
    return NextResponse.json(
      { ok: false, error: `FR24 ${fr.status}: ${(await fr.text()).slice(0, 200)}` }, { status: 502 })
  }
  const items: any[] = (await fr.json()).data ?? []

  const applied: string[] = []

  for (const w of wanted) {
    const num = w.row.callsign ?? w.row.iata_number
    const item = items.find(i => i.callsign === num || i.flight === num)
    if (!item) continue

    if (w.need === 'dep' && item.datetime_takeoff) {
      const ts = Math.floor(new Date(item.datetime_takeoff).getTime() / 1000)
      // The departure belongs on the departure airport's board, which is ours only when the
      // flight left Syria.
      const ap = w.row.dep_iata && SYRIA_AIRPORT_SET.has(w.row.dep_iata) ? w.row.dep_iata : null
      const ok = ap ? await writeActual(ap, w.row.flight_date, w.row.iata_number, 'real_dep', ts) : false
      await fetch(`${SB_URL}/rest/v1/flight_signal_log?callsign=eq.${encodeURIComponent(num)}&flight_date=eq.${today}`, {
        method: 'PATCH', headers: { ...HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({ real_dep_synced: true, actual_dep_at: item.datetime_takeoff }),
      })
      applied.push(`${num} dep ${item.datetime_takeoff}${ok ? '' : ' (board not updated)'}`)
    }

    if (w.need === 'arr' && item.datetime_landed) {
      const ts = Math.floor(new Date(item.datetime_landed).getTime() / 1000)
      const ap = w.row.arr_iata && SYRIA_AIRPORT_SET.has(w.row.arr_iata) ? w.row.arr_iata : null
      const ok = ap ? await writeActual(ap, w.row.flight_date, w.row.iata_number, 'real_arr', ts) : false
      await fetch(`${SB_URL}/rest/v1/flight_signal_log?callsign=eq.${encodeURIComponent(num)}&flight_date=eq.${today}`, {
        method: 'PATCH', headers: { ...HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({ real_arr_synced: true, actual_arr_at: item.datetime_landed }),
      })
      // The flight flew, late. Closing the row is what distinguishes it from one that never
      // operated at all.
      await fetch(`${SB_URL}/rest/v1/flight_no_activity?id=eq.${w.row.id}`, {
        method: 'PATCH', headers: { ...HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({
          resolved_at: new Date().toISOString(),
          resolved_reason: `flew late — landed ${item.datetime_landed}`,
        }),
      })
      applied.push(`${num} arr ${item.datetime_landed}${ok ? '' : ' (board not updated)'}`)
    }
  }

  return NextResponse.json({
    ok: true, open: open.length, signals: signals.length,
    called: 1, asked: nums, applied,
  })
}

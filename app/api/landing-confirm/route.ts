import { NextResponse } from 'next/server'
import { SYRIA_AIRPORTS, SYRIA_ICAO } from '@/lib/syria-airports'

export const dynamic = 'force-dynamic'

const SB_URL      = process.env.SUPABASE_URL!
const SB_KEY      = process.env.SUPABASE_ANON_KEY!
const FR24_TOKEN  = process.env.FR24_API_KEY
const HEADERS     = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
const SYRIAN_AIRPORTS = [...SYRIA_AIRPORTS]
const IATA_TO_ICAO = SYRIA_ICAO

function syriaDate(offsetDays = 0): string {
  const ms = Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The last resort: FR24's own estimate, for flights it never resolves.
 *
 * Aleppo's board on 13 Aug had four Landed and five Unknown, every Unknown carrying a live
 * estimate — RJ431 05:20 against a 05:40 schedule, J9175 13:48 against 14:10. Those are revised
 * figures, not the timetable repeated: FR24 updates them while the aircraft is flying and then
 * stops, because its coverage ends before touchdown. Waiting for a landing that will not come
 * leaves half the Aleppo board permanently unfinished.
 *
 * Three hours past the estimate, and never over a value already present. Three hours because
 * FR24 does backfill — its site carries RJ431's arrival on every day but today — so this must
 * not pre-empt a real landing that is merely late.
 *
 * Its own function, and called before the early return above rather than after it. Inlined at
 * the end it never ran: `if (!pending.length) return` fires whenever the summary window is
 * empty, which is most of the time, and that is exactly when the estimate is the only thing
 * left to work with.
 *
 * Recorded as `fr24_estimate` so it is never mistaken for an observation. It is the weakest of
 * the three tiers and the only one where nobody saw anything.
 */
async function assumeFromEstimate(): Promise<number> {
  const estCutoff = new Date(Date.now() - 3 * 3_600_000).toISOString()
  const res = await fetch(
    `${SB_URL}/rest/v1/flight?flight_date=in.(${syriaDate(-1)},${syriaDate(0)})`
      + `&arr_iata=in.(${SYRIAN_AIRPORTS.join(',')})&real_arr=is.null&arr_confirmed_at=is.null`
      + `&real_dep=not.is.null&est_arr=not.is.null&est_arr=lt.${estCutoff}`
      + `&outcome=not.in.(cancelled,diverted)`
      + `&select=flight_date,iata_number,arr_iata,est_arr`,
    { headers: HEADERS, cache: 'no-store' },
  )
  if (!res.ok) return 0
  const rows = (await res.json()) as
    { flight_date: string; iata_number: string; arr_iata: string; est_arr: string }[]
  let n = 0
  for (const r of rows) {
    const w = await fetch(
      `${SB_URL}/rest/v1/flight?iata_number=eq.${encodeURIComponent(r.iata_number)}`
        + `&flight_date=eq.${r.flight_date}&arr_iata=eq.${r.arr_iata}`
        + `&real_arr=is.null&arr_confirmed_at=is.null`,
      {
        method: 'PATCH',
        headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ arr_confirmed_at: r.est_arr, arr_confirmed_src: 'fr24_estimate' }),
      },
    )
    if (w.ok) n++
  }
  return n
}

export async function GET() {
  if (!FR24_TOKEN) {
    return NextResponse.json({ ok: false, error: 'FR24_API_KEY not configured' }, { status: 500 })
  }

  const nowSec    = Math.floor(Date.now() / 1000)
  const minAgeSec = nowSec - 30 * 60   // at least 30 min past ETA
  const maxAgeSec = nowSec - 4 * 3600  // give up after 4 h

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Pending = { airport: string; date: string; num: string; eta: number }
  const pending: Pending[] = []

  /*
   * The flights still owed an arrival, from `flight` rather than the cache.
   *
   * Yesterday and today: an arrival more than four hours past its estimate is not coming, and
   * one less than thirty minutes past has not had time to be published.
   */
  {
    const res = await fetch(
      `${SB_URL}/rest/v1/flight?flight_date=in.(${syriaDate(-1)},${syriaDate(0)})`
        + `&arr_iata=in.(${SYRIAN_AIRPORTS.join(',')})&real_arr=is.null&real_dep=not.is.null`
        + `&select=flight_date,iata_number,arr_iata,est_arr,sched_arr,outcome`,
      { headers: HEADERS, cache: 'no-store' },
    )
    if (res.ok) {
      type Row = {
        flight_date: string; iata_number: string; arr_iata: string
        est_arr: string | null; sched_arr: string | null; outcome: string | null
      }
      for (const f of (await res.json()) as Row[]) {
        // A cancelled flight has no arrival, and a diverted one did not arrive here.
        if (f.outcome === 'cancelled' || f.outcome === 'diverted') continue
        const stamp = f.est_arr ?? f.sched_arr
        if (!stamp) continue
        const eta = Math.floor(Date.parse(stamp) / 1000)
        if (!Number.isFinite(eta) || eta > minAgeSec || eta < maxAgeSec) continue
        pending.push({ airport: f.arr_iata, date: f.flight_date, num: f.iata_number, eta })
      }
    }
  }

  if (!pending.length) {
    return NextResponse.json({ ok: true, checked: 0, confirmed: 0, assumed: await assumeFromEstimate() })
  }

  /*
   * Ask FR24 by broadcast callsign, not by commercial flight number.
   *
   * `callsigns=` matches only what the transponder sends. The cache stores the commercial
   * number — RB444 — and sending that returned zero records every run, so nothing ever matched
   * and nothing was ever confirmed. Verified directly on 8 Aug: callsigns=RB444 gave 0 records,
   * callsigns=SYR444 gave the flight with datetime_landed 18:59:07Z.
   *
   * It went unnoticed because Fly Cham is stored under its ICAO number (FYC781), which *is*
   * the callsign — so the one carrier that worked made the cron look alive while it was
   * failing for RB, J9, FZ, EY, 3L and every other airline whose two codes differ.
   *
   * Both forms are sent: the resolved callsign where flight_lookup knows one, and the number
   * itself as a fallback for anything unmapped or already stored in ICAO form.
   */
  const nums = [...new Set(pending.map(p => p.num))]
  const csRes = await fetch(
    `${SB_URL}/rest/v1/flight_lookup?iata_number=in.(${nums.map(encodeURIComponent).join(',')})`
    + `&select=iata_number,broadcast_callsign`,
    { headers: HEADERS }
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lookupRows: any[] = csRes.ok ? await csRes.json() : []
  const numToCallsign = new Map<string, string>()
  for (const r of lookupRows) {
    if (r.broadcast_callsign) numToCallsign.set(r.iata_number, r.broadcast_callsign)
  }
  const callsigns = [...new Set(nums.flatMap(n => {
    const cs = numToCallsign.get(n)
    return cs && cs !== n ? [cs, n] : [n]
  }))]

  // Query flight-summary for all pending callsigns in a 48-hour window
  const from = new Date(Date.now() - 8 * 3_600_000).toISOString().slice(0, 19)
  const to   = new Date().toISOString().slice(0, 19)

  const summaryUrl = `https://fr24api.flightradar24.com/api/flight-summary/light`
    + `?callsigns=${encodeURIComponent(callsigns.join(','))}`
    + `&flight_datetime_from=${encodeURIComponent(from)}`
    + `&flight_datetime_to=${encodeURIComponent(to)}`
    + `&limit=200`

  const fr24Res = await fetch(summaryUrl, {
    headers: { Authorization: `Bearer ${FR24_TOKEN}`, Accept: 'application/json', 'Accept-Version': 'v1' },
  })

  if (!fr24Res.ok) {
    const body = await fr24Res.text()
    return NextResponse.json(
      { ok: false, error: `FR24 API ${fr24Res.status}: ${body.slice(0, 300)}` },
      { status: 502 }
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = (await fr24Res.json()).data ?? []

  let confirmed = 0

  for (const p of pending) {
    const destIcao = IATA_TO_ICAO[p.airport]
    if (!destIcao) continue

    /*
     * Match by callsign (FYC728) or commercial flight number (TK848), destination, and ETA
     * proximity.
     *
     * datetime_landed is no longer required, and that is the point. FR24 derives a landing
     * from the track reaching the destination, and over Syria the track ends before touchdown
     * — coverage drops on the last leg. RB516 on 6 August had a full track, KML and CSV on
     * FR24's own site and no landing time at all. Requiring datetime_landed meant asking FR24
     * for something it structurally cannot know about arrivals into Syrian airspace, which is
     * most of what this cron exists to confirm.
     *
     * So a finished flight with a last_seen is accepted too. last_seen is where coverage
     * stopped, which for an arrival into Syria is close to the airport — minutes out rather
     * than unknown.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wantCs = numToCallsign.get(p.num) ?? null
    const match = items.find((item: any) => {
      // Either identifier is acceptable: FR24 returns both, and which one is populated has
      // varied by carrier.
      if (item.callsign !== p.num && item.flight !== p.num
          && (!wantCs || (item.callsign !== wantCs && item.flight !== wantCs))) return false
      if (item.dest_icao_actual !== destIcao && item.dest_icao !== destIcao) return false
      const stamp = item.datetime_landed ?? (item.flight_ended ? item.last_seen : null)
      if (!stamp) return false
      const landedAt = Math.floor(new Date(stamp).getTime() / 1000)
      return Math.abs(landedAt - p.eta) <= 6 * 3600
    })

    if (!match) continue

    // Recorded which of the two it was, because they are not the same claim: one is a landing
    // FR24 computed, the other is the last point at which anyone could see the aircraft.
    const fromTrack  = !!match.datetime_landed
    const landedStamp = match.datetime_landed ?? match.last_seen
    const landedAt    = Math.floor(new Date(landedStamp).getTime() / 1000)

    const tookOff = match.datetime_takeoff
      ? new Date(match.datetime_takeoff).toISOString()
      : null

    /*
     * Written to `flight`, and into two different columns, because they are two different claims.
     *
     * datetime_landed is a landing FR24 computed — that is what real_arr means, and it is the
     * same fact the harvester writes when FR24 publishes one on the board.
     *
     * last_seen is where coverage stopped. Over Syria that is close to the airport but it is not
     * a landing, and putting it in real_arr would make a published fact and an observation
     * indistinguishable — the same reason the inferred-departure writeback was deleted rather
     * than pointed at real_dep. It goes to arr_confirmed_at with its source named.
     *
     * Neither ever overwrites a value already there: the harvester reads FR24's board every
     * sweep and is closer to the source than a summary fetched hours later.
     */
    const patch: Record<string, unknown> = {}
    if (fromTrack) patch.real_arr = new Date(landedAt * 1000).toISOString()
    else {
      patch.arr_confirmed_at  = new Date(landedAt * 1000).toISOString()
      patch.arr_confirmed_src = 'fr24_last_seen'
    }
    if (tookOff) patch.real_dep = tookOff

    const cond = `iata_number=eq.${encodeURIComponent(p.num)}&flight_date=eq.${p.date}`
      + `&arr_iata=eq.${p.airport}`
      + (fromTrack ? '&real_arr=is.null' : '&arr_confirmed_at=is.null&real_arr=is.null')
      + (tookOff ? '' : '')

    const writeRes = await fetch(`${SB_URL}/rest/v1/flight?${cond}`, {
      method:  'PATCH',
      headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    })
    if (writeRes.ok) confirmed++
  }

  const assumed = await assumeFromEstimate()

  return NextResponse.json({ ok: true, checked: pending.length, confirmed, assumed, callsigns })
}

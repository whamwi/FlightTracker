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

  for (const date of [syriaDate(-1), syriaDate(0)]) {
    // For yesterday, only look at flights scheduled after Syria midnight (21:00 UTC)
    // — daytime flights with no real_arr are simply missing data, not worth querying
    const syriaMidnight = date === syriaDate(-1)
      ? Math.floor(new Date(date + 'T21:00:00Z').getTime() / 1000)
      : 0

    const res = await fetch(
      `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${date}&airport_iata=in.(${SYRIAN_AIRPORTS.join(',')})&select=airport_iata,arrivals`,
      { headers: HEADERS }
    )
    if (!res.ok) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of (await res.json() as any[])) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const f of (row.arrivals ?? []) as any[]) {
        if (f.real_arr) continue
        if (!f.num)     continue
        const eta = (f.est_arr ?? f.sched_arr) as number | null
        if (!eta || eta > minAgeSec || eta < maxAgeSec) continue
        if (syriaMidnight && eta < syriaMidnight) continue
        pending.push({ airport: row.airport_iata as string, date, num: String(f.num), eta })
      }
    }
  }

  if (!pending.length) return NextResponse.json({ ok: true, checked: 0, confirmed: 0 })

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

    const rowRes = await fetch(
      `${SB_URL}/rest/v1/fr24_daily_cache?airport_iata=eq.${p.airport}&flight_date=eq.${p.date}&select=arrivals,departures`,
      { headers: HEADERS }
    )
    if (!rowRes.ok) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await rowRes.json()
    if (!rows.length) continue

    const d    = new Date(landedAt * 1000)
    const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

    /*
     * The departure comes from the same response and was being thrown away.
     *
     * flight-summary returns datetime_takeoff beside the landing, and this cron ignored it
     * because it was written to confirm arrivals. RB516 on 6 August had its takeoff — 09:20Z —
     * sitting in a response we had already paid for and discarded, while the board showed the
     * flight as Scheduled with no departure at all.
     *
     * Only filled in, never overwritten: a departure already on the row came from the widget
     * or from a live ADS-B confirmation, and both are closer to the source than a summary
     * fetched hours later.
     */
    const tookOff = match.datetime_takeoff
      ? Math.floor(new Date(match.datetime_takeoff).getTime() / 1000)
      : null

    // Status says what is actually known. A track-derived arrival is not a published landing,
    // and labelling it as one would put a precise time behind a claim FR24 never made.
    const arrStatus = fromTrack ? `Landed ${hhmm}` : `Arrived ${hhmm}`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arrivals = (rows[0].arrivals ?? [] as any[]).map((f: any) =>
      f.num === p.num
        ? {
            ...f,
            fr24_id:  match.fr24_id,
            real_arr: landedAt,
            real_dep: f.real_dep ?? tookOff ?? null,
            // Published by FR24, so it supersedes anything we estimated from position.
            dep_source: f.real_dep ? (f.dep_source ?? 'fr24') : tookOff ? 'fr24' : (f.dep_source ?? null),
            reg:      f.reg || match.reg || null,
            status:   arrStatus,
          }
        : f
    )

    const writeRes = await fetch(`${SB_URL}/rest/v1/fr24_daily_cache`, {
      method:  'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        airport_iata: p.airport,
        flight_date:  p.date,
        arrivals,
        departures:   rows[0].departures ?? [],
        arr_count:    arrivals.length,
        fetched_at:   new Date().toISOString(),
      }),
    })
    if (writeRes.ok) confirmed++
  }

  return NextResponse.json({ ok: true, checked: pending.length, confirmed, callsigns })
}

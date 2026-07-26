import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL      = process.env.SUPABASE_URL!
const SB_KEY      = process.env.SUPABASE_ANON_KEY!
const FR24_TOKEN  = process.env.FR24_API_KEY
const HEADERS     = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
const SYRIAN_AIRPORTS = ['DAM', 'ALP', 'LTK']
const IATA_TO_ICAO: Record<string, string> = { DAM: 'OSDI', ALP: 'OSAP', LTK: 'OSLK' }

function syriaDate(offsetDays = 0): string {
  const ms = Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

export async function GET() {
  if (!FR24_TOKEN) {
    return NextResponse.json({ ok: false, error: 'FR24_API_KEY not configured' }, { status: 500 })
  }

  const nowSec       = Math.floor(Date.now() / 1000)
  const minAgeSec    = nowSec - 30 * 60    // at least 30 min past ETA → landing confirmation
  const maxAgeSec    = nowSec - 4 * 3600   // give up after 4 h
  const aheadSec     = nowSec + 6 * 3600   // look up to 6 h ahead for en-route

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Pending  = { airport: string; date: string; num: string; eta: number }
  type EnRoute  = { airport: string; date: string; num: string }
  const pending:  Pending[]  = []
  const enRoute:  EnRoute[]  = []

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
        if (!eta) continue

        // En-route: ETA within next 6h, no real_dep yet → fetch datetime_takeoff
        if (eta > minAgeSec && eta <= aheadSec && !f.real_dep) {
          enRoute.push({ airport: row.airport_iata as string, date, num: String(f.num) })
          continue
        }

        // Pending: 30min–4h past ETA → confirm landing
        if (eta <= minAgeSec && eta >= maxAgeSec) {
          if (syriaMidnight && eta < syriaMidnight) continue
          pending.push({ airport: row.airport_iata as string, date, num: String(f.num), eta })
        }
      }
    }
  }

  if (!pending.length && !enRoute.length) return NextResponse.json({ ok: true, checked: 0, confirmed: 0, enroute: 0 })

  const callsigns = [...new Set([...pending.map(p => p.num), ...enRoute.map(e => e.num)])]

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

    // Match by callsign (FYC728) or commercial flight number (TK848), destination, and ETA proximity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = items.find((item: any) => {
      if (item.callsign !== p.num && item.flight !== p.num) return false
      if (item.dest_icao_actual !== destIcao && item.dest_icao !== destIcao) return false
      if (!item.datetime_landed) return false
      const landedAt = Math.floor(new Date(item.datetime_landed).getTime() / 1000)
      return Math.abs(landedAt - p.eta) <= 6 * 3600
    })

    if (!match) continue

    const landedAt = Math.floor(new Date(match.datetime_landed).getTime() / 1000)

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arrivals = (rows[0].arrivals ?? [] as any[]).map((f: any) =>
      f.num === p.num ? { ...f, fr24_id: match.fr24_id, real_arr: landedAt, status: `Landed ${hhmm}` } : f
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

  // Write real_dep for en-route flights (datetime_takeoff → progress bar on board)
  let depUpdated = 0
  for (const e of enRoute) {
    const destIcao = IATA_TO_ICAO[e.airport]
    if (!destIcao) continue

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = items.find((item: any) => {
      if (item.callsign !== e.num && item.flight !== e.num) return false
      if (item.dest_icao_actual !== destIcao && item.dest_icao !== destIcao) return false
      return !!item.datetime_takeoff && !item.flight_ended && !item.datetime_landed
    })
    if (!match) continue

    const realDep = Math.floor(new Date(match.datetime_takeoff).getTime() / 1000)

    const rowRes = await fetch(
      `${SB_URL}/rest/v1/fr24_daily_cache?airport_iata=eq.${e.airport}&flight_date=eq.${e.date}&select=arrivals,departures`,
      { headers: HEADERS }
    )
    if (!rowRes.ok) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await rowRes.json()
    if (!rows.length) continue

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arrivals = (rows[0].arrivals ?? [] as any[]).map((f: any) =>
      f.num === e.num ? { ...f, fr24_id: match.fr24_id, real_dep: realDep } : f
    )

    const writeRes = await fetch(`${SB_URL}/rest/v1/fr24_daily_cache`, {
      method:  'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        airport_iata: e.airport,
        flight_date:  e.date,
        arrivals,
        departures:   rows[0].departures ?? [],
        arr_count:    arrivals.length,
        fetched_at:   new Date().toISOString(),
      }),
    })
    if (writeRes.ok) depUpdated++
  }

  return NextResponse.json({ ok: true, checked: pending.length, confirmed, enroute: enRoute.length, dep_updated: depUpdated, callsigns })
}

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_ANON_KEY!
const FR24_TOKEN = process.env.FR24_API_TOKEN
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
const SYRIAN_AIRPORTS = ['DAM', 'ALP', 'LTK']

function syriaDate(offsetDays = 0): string {
  const ms = Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

// GET /api/landing-confirm
// Finds arrivals that are 30 min past their ETA with no confirmed landing,
// calls the FR24 historic events API, and writes real_arr back to the cache.
// Intended to run every 15 min via Vercel cron.
export async function GET() {
  if (!FR24_TOKEN) {
    return NextResponse.json({ ok: false, error: 'FR24_API_TOKEN not configured' }, { status: 500 })
  }

  const nowSec    = Math.floor(Date.now() / 1000)
  const minAgeSec = nowSec - 30 * 60     // at least 30 min past ETA before we check
  const maxAgeSec = nowSec - 4 * 3600    // give up after 4 h with no confirmation

  type Pending = { airport: string; date: string; fr24_id: string; num: string }
  const pending: Pending[] = []

  for (const date of [syriaDate(-1), syriaDate(0)]) {
    const res = await fetch(
      `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${date}&airport_iata=in.(${SYRIAN_AIRPORTS.join(',')})&select=airport_iata,arrivals`,
      { headers: HEADERS }
    )
    if (!res.ok) continue

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of (await res.json() as any[])) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const f of (row.arrivals ?? []) as any[]) {
        if (f.real_arr)   continue   // already confirmed
        if (!f.fr24_id)   continue   // no FR24 ID stored — skip
        const eta = (f.est_arr ?? f.sched_arr) as number | null
        if (!eta || eta > minAgeSec || eta < maxAgeSec) continue
        pending.push({ airport: row.airport_iata as string, date, fr24_id: String(f.fr24_id), num: f.num ?? '' })
      }
    }
  }

  if (!pending.length) return NextResponse.json({ ok: true, checked: 0, confirmed: 0 })

  // Deduplicate by fr24_id (same flight may appear in multiple rows if same route)
  const byId = new Map(pending.map(p => [p.fr24_id, p]))
  const ids  = [...byId.keys()]

  // Call FR24 historic flight-events API
  // SDK equivalent: client.historic.flight_events.get_light(flight_ids=[...], event_types=["landed"])
  const params = ids.map(id => `flight_ids=${encodeURIComponent(id)}`).join('&')
  const fr24Res = await fetch(
    `https://fr24api.flightradar24.com/api/historic/flight-events?${params}&event_types=landed`,
    { headers: { Authorization: `Bearer ${FR24_TOKEN}`, Accept: 'application/json' } }
  )

  if (!fr24Res.ok) {
    const body = await fr24Res.text()
    return NextResponse.json(
      { ok: false, error: `FR24 API ${fr24Res.status}: ${body.slice(0, 300)}` },
      { status: 502 }
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fr24Data: any = await fr24Res.json()

  // Handle both { data: [...] } wrapper and bare array
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = Array.isArray(fr24Data) ? fr24Data : (fr24Data.data ?? [])

  // Extract landing timestamp for each flight_id
  const landings = new Map<string, number>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const item of items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = (item.events ?? [] as any[]).find((e: any) =>
      String(e.type ?? '').toLowerCase().includes('land')
    )
    if (ev?.timestamp) landings.set(String(item.flight_id), Number(ev.timestamp))
  }

  if (!landings.size) {
    return NextResponse.json({ ok: true, checked: ids.length, confirmed: 0 })
  }

  // Write confirmed landings back to fr24_daily_cache
  let confirmed = 0
  for (const [fr24Id, landedAt] of landings) {
    const p = byId.get(fr24Id)
    if (!p) continue

    // Read the full row so we can modify just the matching flight
    const rowRes = await fetch(
      `${SB_URL}/rest/v1/fr24_daily_cache?airport_iata=eq.${p.airport}&flight_date=eq.${p.date}&select=arrivals,departures`,
      { headers: HEADERS }
    )
    if (!rowRes.ok) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await rowRes.json()
    if (!rows.length) continue

    // Build status string: "Landed HH:MM" in UTC (flightboard normalises it to Syria local)
    const d = new Date(landedAt * 1000)
    const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arrivals = (rows[0].arrivals ?? [] as any[]).map((f: any) =>
      f.fr24_id === fr24Id
        ? { ...f, real_arr: landedAt, status: `Landed ${hhmm}` }
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

  return NextResponse.json({
    ok: true,
    checked:   ids.length,
    confirmed,
    flights:   [...landings.keys()],
  })
}

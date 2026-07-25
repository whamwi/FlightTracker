import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_ANON_KEY!
const FR24_TOKEN = process.env.FR24_API_KEY
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
const SYRIAN_AIRPORTS = ['DAM', 'ALP', 'LTK']

function syriaDate(offsetDays = 0): string {
  const ms = Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

// GET /api/landing-confirm
// Finds arrivals 30 min–4 h past ETA with no confirmed landing,
// looks up their FR24 IDs from flight_lookup (stable route-level IDs),
// calls the FR24 historic events API, and writes real_arr back to the cache.
// Runs every 15 min via Vercel cron.
export async function GET() {
  if (!FR24_TOKEN) {
    return NextResponse.json({ ok: false, error: 'FR24_API_KEY not configured' }, { status: 500 })
  }

  const nowSec    = Math.floor(Date.now() / 1000)
  const minAgeSec = nowSec - 30 * 60   // at least 30 min past ETA
  const maxAgeSec = nowSec - 4 * 3600  // give up after 4 h

  type Pending = { airport: string; date: string; num: string; eta: number }
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
        if (f.real_arr) continue
        if (!f.num)     continue
        const eta = (f.est_arr ?? f.sched_arr) as number | null
        if (!eta || eta > minAgeSec || eta < maxAgeSec) continue
        pending.push({ airport: row.airport_iata as string, date, num: String(f.num), eta })
      }
    }
  }

  if (!pending.length) return NextResponse.json({ ok: true, checked: 0, confirmed: 0 })

  // Look up stable FR24 route IDs from flight_lookup.
  // Cache stores num in broadcast_callsign format (e.g. "FYC728") while
  // iata_number may differ (e.g. "XH728") — query both columns and map either.
  const uniqueNums = [...new Set(pending.map(p => p.num))]
  const numsParam = uniqueNums.join(',')
  const lookupRes = await fetch(
    `${SB_URL}/rest/v1/flight_lookup?or=(iata_number.in.(${numsParam}),broadcast_callsign.in.(${numsParam}))&select=iata_number,broadcast_callsign,fr24_id`,
    { headers: HEADERS }
  )
  if (!lookupRes.ok) {
    return NextResponse.json({ ok: false, error: `flight_lookup fetch failed: ${lookupRes.status}` }, { status: 502 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lookupRows: any[] = await lookupRes.json()
  const numToFr24Id = new Map<string, string>()
  for (const row of lookupRows) {
    if (!row.fr24_id) continue
    // Map both columns so whichever format the cache used resolves correctly
    if (row.iata_number)       numToFr24Id.set(row.iata_number as string, row.fr24_id as string)
    if (row.broadcast_callsign) numToFr24Id.set(row.broadcast_callsign as string, row.fr24_id as string)
  }

  // Group pending entries by fr24_id (one fr24_id may cover multiple airport/date combos)
  const byFr24Id = new Map<string, Pending[]>()
  for (const p of pending) {
    const id = numToFr24Id.get(p.num)
    if (!id) continue
    if (!byFr24Id.has(id)) byFr24Id.set(id, [])
    byFr24Id.get(id)!.push(p)
  }

  if (!byFr24Id.size) {
    return NextResponse.json({ ok: true, checked: 0, confirmed: 0, note: 'no fr24_id found for pending flights' })
  }

  const ids = [...byFr24Id.keys()]

  // Call FR24 historic flight-events API
  const params = ids.map(id => `flight_ids=${encodeURIComponent(id)}`).join('&')
  const fr24Res = await fetch(
    `https://fr24api.flightradar24.com/api/historic/flight-events/light?${params}&event_types=all`,
    { headers: { Authorization: `Bearer ${FR24_TOKEN}`, Accept: 'application/json', 'Accept-Version': 'v1' } }
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = Array.isArray(fr24Data) ? fr24Data : (fr24Data.data ?? [])

  // Extract landing timestamp per fr24_id
  // API returns: { fr24_id, events: [{ type: "landed", timestamp: "2026-07-08T18:54:39Z" }] }
  const landings = new Map<string, number>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const item of items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = (item.events ?? [] as any[]).find((e: any) =>
      String(e.type ?? '').toLowerCase().includes('land')
    )
    if (ev?.timestamp) landings.set(String(item.fr24_id), Math.floor(new Date(ev.timestamp).getTime() / 1000))
  }

  if (!landings.size) {
    return NextResponse.json({ ok: true, checked: ids.length, confirmed: 0 })
  }

  // Write confirmed landings back to fr24_daily_cache
  let confirmed = 0
  for (const [fr24Id, landedAt] of landings) {
    const entries = byFr24Id.get(fr24Id) ?? []
    for (const p of entries) {
      // Reject if landing time is more than 6 h away from expected ETA —
      // stable route IDs can return events from a past flight on a different date
      if (Math.abs(landedAt - p.eta) > 6 * 3600) continue
      const rowRes = await fetch(
        `${SB_URL}/rest/v1/fr24_daily_cache?airport_iata=eq.${p.airport}&flight_date=eq.${p.date}&select=arrivals,departures`,
        { headers: HEADERS }
      )
      if (!rowRes.ok) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[] = await rowRes.json()
      if (!rows.length) continue

      const d = new Date(landedAt * 1000)
      const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arrivals = (rows[0].arrivals ?? [] as any[]).map((f: any) =>
        f.num === p.num
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
  }

  return NextResponse.json({
    ok: true,
    checked:  ids.length,
    confirmed,
    flights:  [...landings.keys()],
  })
}

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function statusRank(s: string | null | undefined): number {
  const t = (s ?? '').toLowerCase()
  if (t.includes('cancel'))                           return 9  // definitive — never downgrade
  if (t.includes('landed') || t.includes('arrived')) return 8
  if (t.includes('approach'))                         return 7
  if (t.includes('en route') || t.includes('in flight')) return 6
  if (t.includes('departed') || t.includes('took off')) return 5
  if (t.startsWith('delayed'))                        return 4
  if (t.includes('boarding') || t.includes('gate close')) return 3
  if (t.startsWith('estimated') || t.startsWith('expect')) return 2
  if (t === 'scheduled' || t === 'scheduled*')        return 1
  return 0
}

// Merge an incoming list with the existing DB list.
// Rules (in priority order):
//   1. If existing has real_arr (confirmed landing) → always keep existing
//   2. If incoming has real_arr and existing doesn't → use incoming
//   3. Otherwise take whichever has the higher status rank
//   4. Flights that aged out of the FR24 feed but have real_arr are preserved
/**
 * How much this row proves the flight is real, for breaking a tie between two rows with the
 * same status. A timetable stub carries none of these; only a flight FR24 actually tracked
 * gains a tail number, an id, or a time.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evidence(e: any): number {
  return (e.real_arr ? 8 : 0) + (e.real_dep ? 4 : 0) + (e.fr24_id ? 2 : 0) + (e.reg ? 1 : 0)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeList(existing: any[], incoming: any[], keyFn: (e: any) => string): any[] {
  const merged = new Map<string, any>()
  const nowSec = Math.floor(Date.now() / 1000)

  /*
   * Seed with incoming (fresh FR24 data is the baseline).
   *
   * FR24 publishes two rows for the same flight: a bare timetable stub and the operated
   * flight. Usually the operated one carries a better status — FYC485 was "Departed 01:37"
   * against the stub's "Unknown" — and rank alone picks it.
   *
   * But both rows can be "Unknown". RB516 DXB–DAM on 6 August was exactly that: the operated
   * row had a registration, an fr24_id and a real departure of 09:20Z, the stub had nothing,
   * and both said Unknown. Ranks tied, `>=` kept whichever arrived last, the stub won, and the
   * board showed a flight that had actually flown as merely Scheduled.
   *
   * So a tie is broken on evidence rather than order. A stub can never acquire a tail number.
   */
  for (const e of incoming) {
    const key = keyFn(e)
    const prev = merged.get(key)
    if (!prev) { merged.set(key, e); continue }

    const rank = statusRank(e.status) - statusRank(prev.status)
    if (rank > 0) { merged.set(key, e); continue }
    if (rank < 0) continue
    if (evidence(e) > evidence(prev)) merged.set(key, e)
  }

  // Walk existing; override incoming where existing data is richer
  for (const e of existing) {
    const key = keyFn(e)
    const inc = merged.get(key)
    if (!inc) {
      // Flight aged out of FR24 feed — preserve if:
      //   • confirmed landing (real_arr set), OR
      //   • has FR24 ID for historic lookup and ETA was within the last 4 h (awaiting confirmation)
      const pendingConfirm = e.fr24_id && e.est_arr && (nowSec - (e.est_arr as number)) < 4 * 3600
      if (e.real_arr || pendingConfirm) merged.set(key, e)
    } else if (e.real_arr && !inc.real_arr) {
      // Existing proved the flight landed; incoming lost that data
      // Forward fr24_id from incoming so it isn't lost when existing wins
      merged.set(key, { ...e, fr24_id: e.fr24_id ?? inc.fr24_id ?? null })
    } else if (!inc.real_arr && statusRank(e.status) > statusRank(inc.status) && (e.fr24_id || e.real_dep)) {
      // Existing has a higher-quality status, has been ADS-B tracked, and neither has landing proof
      merged.set(key, { ...e, fr24_id: e.fr24_id ?? inc.fr24_id ?? null })
    }
  }

  return [...merged.values()]
}

export async function POST(req: Request) {
  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const { airport_iata, flight_date, arrivals, departures } = body as {
    airport_iata: string
    flight_date:  string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arrivals:     any[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    departures:   any[]
  }

  if (!airport_iata || !flight_date || !Array.isArray(arrivals) || !Array.isArray(departures)) {
    return NextResponse.json({ ok: false, error: 'Missing fields' }, { status: 400 })
  }

  // Load allowed airline IATA codes from the airlines table.
  // Flights whose airline_iata is set but not in this table are FR24 artifacts (e.g. Taquan Air)
  // and must not be persisted. Flights with airline_iata = null pass through unchecked
  // (some legitimate carriers like Fly Cham have no IATA code in FR24's response).
  const airlinesRes = await fetch(`${SB_URL}/rest/v1/airlines?select=iata`, { headers: HEADERS })
  const allowedIatas = new Set<string>()
  if (airlinesRes.ok) {
    const rows: { iata: string }[] = await airlinesRes.json()
    for (const r of rows) if (r.iata) allowedIatas.add(r.iata)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filterKnown = (list: any[]) =>
    list.filter(f => !f.airline_iata || allowedIatas.has(f.airline_iata))

  const filteredArrivals   = filterKnown(arrivals)
  const filteredDepartures = filterKnown(departures)

  // Read existing row so we can merge rather than blindly replace
  const existRes = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache?airport_iata=eq.${airport_iata}&flight_date=eq.${flight_date}&select=arrivals,departures`,
    { headers: HEADERS }
  )

  let mergedArrivals:   typeof arrivals   = filteredArrivals
  let mergedDepartures: typeof departures = filteredDepartures

  if (existRes.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await existRes.json()
    if (rows.length > 0) {
      const ex = rows[0]
      mergedArrivals   = mergeList(ex.arrivals   ?? [], filteredArrivals,   e => `${e.num ?? ''}|${e.dep_iata ?? ''}`)
      mergedDepartures = mergeList(ex.departures  ?? [], filteredDepartures, e => `${e.num ?? ''}|${e.arr_iata ?? ''}`)
    }
  }

  const res = await fetch(`${SB_URL}/rest/v1/fr24_daily_cache`, {
    method:  'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      airport_iata,
      flight_date,
      arrivals:   mergedArrivals,
      departures: mergedDepartures,
      arr_count:  mergedArrivals.length,
      dep_count:  mergedDepartures.length,
      fetched_at: new Date().toISOString(),
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ ok: false, error: err }, { status: 502 })
  }

  return NextResponse.json({ ok: true, airport: airport_iata, date: flight_date, arr: mergedArrivals.length, dep: mergedDepartures.length })
}

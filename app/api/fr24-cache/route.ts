import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function statusRank(s: string | null | undefined): number {
  const t = (s ?? '').toLowerCase()
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeList(existing: any[], incoming: any[], keyFn: (e: any) => string): any[] {
  const merged = new Map<string, any>()
  const nowSec = Math.floor(Date.now() / 1000)

  // Seed with incoming (fresh FR24 data is the baseline)
  for (const e of incoming) merged.set(keyFn(e), e)

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
    } else if (!inc.real_arr && statusRank(e.status) > statusRank(inc.status)) {
      // Existing has a higher-quality status and neither has a landing proof
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

  // Read existing row so we can merge rather than blindly replace
  const existRes = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache?airport_iata=eq.${airport_iata}&flight_date=eq.${flight_date}&select=arrivals,departures`,
    { headers: HEADERS }
  )

  let mergedArrivals:   typeof arrivals   = arrivals
  let mergedDepartures: typeof departures = departures

  if (existRes.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await existRes.json()
    if (rows.length > 0) {
      const ex = rows[0]
      mergedArrivals   = mergeList(ex.arrivals   ?? [], arrivals,   e => `${e.num ?? ''}|${e.dep_iata ?? ''}`)
      mergedDepartures = mergeList(ex.departures  ?? [], departures, e => `${e.num ?? ''}|${e.arr_iata ?? ''}`)
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

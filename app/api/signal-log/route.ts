import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const SYRIAN_AIRPORTS = new Set(['DAM', 'ALP', 'LTK'])

interface SignalReading {
  callsign:    string
  flight_date: string
  lat:         number
  lon:         number
  alt_baro:    number | null
  gs:          number | null
  track:       number | null
  hex:         string | null
  dep_iata:    string | null
  arr_iata:    string | null
  iata_number: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export async function POST(req: Request) {
  let batch: SignalReading[]
  try { batch = await req.json() } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 })
  }
  if (!Array.isArray(batch) || batch.length === 0)
    return NextResponse.json({ ok: false, error: 'empty batch' }, { status: 400 })

  const now = new Date().toISOString()
  await Promise.allSettled(batch.map(r => processReading(r, now)))
  return NextResponse.json({ ok: true, processed: batch.length })
}

async function processReading(r: SignalReading, now: string) {
  const { callsign, flight_date } = r
  if (!callsign || !flight_date || r.lat == null || r.lon == null) return

  const alt = r.alt_baro ?? 0
  const gs  = r.gs       ?? 0

  // 1. Read existing summary row
  const sumRes = await fetch(
    `${SB_URL}/rest/v1/flight_signal_log?callsign=eq.${encodeURIComponent(callsign)}&flight_date=eq.${flight_date}&select=*`,
    { headers: HEADERS }
  )
  const ex: Row | null = sumRes.ok ? ((await sumRes.json() as Row[])[0] ?? null) : null

  // 2. Derive milestone events — never overwrite once set
  const actual_dep_at = ex?.actual_dep_at ?? (gs >= 50  ? now : null)
  const airborne_at   = ex?.airborne_at   ?? (alt > 500 ? now : null)
  const actual_arr_at = ex?.actual_arr_at ?? (
    (ex?.airborne_at || airborne_at) && gs < 30 && alt < 100 ? now : null
  )

  // 3. Insert position row — plain insert, no upsert (captured_at ms precision guarantees uniqueness)
  await fetch(`${SB_URL}/rest/v1/flight_position_log`, {
    method:  'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      callsign, flight_date, captured_at: now,
      lat: r.lat, lon: r.lon,
      alt_baro: r.alt_baro,
      gs:       r.gs,
      track:    r.track,
      hex:      r.hex,
    }),
  })

  // 4. Upsert summary row
  await fetch(`${SB_URL}/rest/v1/flight_signal_log`, {
    method:  'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      callsign,
      flight_date,
      hex:             r.hex,
      dep_iata:        r.dep_iata,
      arr_iata:        r.arr_iata,
      first_seen_at:   ex?.first_seen_at ?? now,
      last_seen_at:    now,
      actual_dep_at,
      airborne_at,
      actual_arr_at,
      real_dep_synced: ex?.real_dep_synced ?? false,
      real_arr_synced: ex?.real_arr_synced ?? false,
    }),
  })

  // 5. Feed confirmed milestones back to fr24_daily_cache
  if (actual_dep_at && !ex?.real_dep_synced && r.dep_iata && SYRIAN_AIRPORTS.has(r.dep_iata) && r.iata_number) {
    await syncToCache('dep', r, actual_dep_at, callsign, flight_date)
  }
  if (actual_arr_at && !ex?.real_arr_synced && r.arr_iata && SYRIAN_AIRPORTS.has(r.arr_iata) && r.iata_number) {
    await syncToCache('arr', r, actual_arr_at, callsign, flight_date)
  }
}

async function syncToCache(
  mode:        'dep' | 'arr',
  r:           SignalReading,
  confirmedAt: string,
  callsign:    string,
  flight_date: string,
) {
  const airport  = (mode === 'dep' ? r.dep_iata : r.arr_iata)!
  const realTs   = Math.floor(new Date(confirmedAt).getTime() / 1000)
  const d        = new Date(confirmedAt)
  const hhmm     = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  const listKey  = mode === 'dep' ? 'departures' : 'arrivals'
  const tsField  = mode === 'dep' ? 'real_dep'   : 'real_arr'
  const statusTx = mode === 'dep' ? `Departed ${hhmm}` : `Landed ${hhmm}`

  const rowRes = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache?airport_iata=eq.${airport}&flight_date=eq.${flight_date}&select=arrivals,departures`,
    { headers: HEADERS }
  )
  if (!rowRes.ok) return
  const rows = await rowRes.json() as Row[]
  if (!rows.length) return

  const list = ((rows[0][listKey] ?? []) as Row[]).map((f: Row) =>
    f.num === r.iata_number ? { ...f, [tsField]: realTs, status: statusTx } : f
  )

  const writeRes = await fetch(`${SB_URL}/rest/v1/fr24_daily_cache`, {
    method:  'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      airport_iata: airport,
      flight_date,
      [listKey]:    list,
      // arrivals upsert must include departures to avoid nulling it out
      ...(mode === 'arr' ? { departures: rows[0].departures ?? [] } : {}),
    }),
  })
  if (!writeRes.ok) return

  // Mark synced so we don't write again on the next tick
  const syncField = mode === 'dep' ? 'real_dep_synced' : 'real_arr_synced'
  await fetch(
    `${SB_URL}/rest/v1/flight_signal_log?callsign=eq.${encodeURIComponent(callsign)}&flight_date=eq.${flight_date}`,
    {
      method:  'PATCH',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [syncField]: true }),
    }
  )
}

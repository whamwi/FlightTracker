import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

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

  // 3. Insert position row — ignore exact-duplicate positions (same lat/lon/alt on stale ADS-B ticks)
  await fetch(`${SB_URL}/rest/v1/flight_position_log`, {
    method:  'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({
      callsign, flight_date, captured_at: now,
      lat: r.lat, lon: r.lon,
      alt_baro: r.alt_baro,
      gs:       r.gs,
      track:    r.track,
      hex:      r.hex,
      dep_iata: r.dep_iata,
      arr_iata: r.arr_iata,
    }),
  })

  // 4. Upsert summary row
  await fetch(`${SB_URL}/rest/v1/flight_signal_log`, {
    method:  'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      callsign,
      flight_date,
      hex:           r.hex,
      dep_iata:      r.dep_iata,
      arr_iata:      r.arr_iata,
      first_seen_at: ex?.first_seen_at ?? now,
      last_seen_at:  now,
      actual_dep_at,
      airborne_at,
      actual_arr_at,
    }),
  })
}

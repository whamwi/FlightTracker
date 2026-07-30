import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!

async function sb(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey:        SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string>),
    },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

function addHours(t: string, h: number): string {
  const [hh, mm] = t.split(':').map(Number)
  const total = ((hh * 60 + mm) + h * 60 + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`
}

export async function POST(req: Request) {
  try {
    const { iata_number, dep_iata, arr_iata, dep_time_utc, arr_time_utc, duration_min, days, unfiled_ids } = await req.json()

    if (!iata_number || !dep_iata || !arr_iata || !dep_time_utc || !days?.length) {
      return NextResponse.json({ ok: false, error: 'Missing required fields' }, { status: 400 })
    }

    // 1. Find airline — try IATA 2-char prefix, then ICAO 3-char prefix
    const p2 = iata_number.slice(0, 2).toUpperCase()
    const p3 = iata_number.slice(0, 3).toUpperCase()
    let airline: { id: number; name_en: string; iata: string } | null = null

    const byIata = await sb(`/airlines?iata=eq.${p2}&select=id,name_en,iata&limit=1`)
    if (byIata?.length) {
      airline = byIata[0]
    } else {
      const byIcao = await sb(`/airlines?icao=eq.${p3}&select=id,name_en,iata&limit=1`)
      if (byIcao?.length) airline = byIcao[0]
    }

    if (!airline) {
      return NextResponse.json({
        ok: false, error: 'airline_not_found',
        message: `No airline found for prefix "${p2}" or ICAO "${p3}". Add the airline first.`,
      }, { status: 422 })
    }

    // 2. Find or create flight_lookup
    const existing = await sb(`/flight_lookup?iata_number=eq.${encodeURIComponent(iata_number)}&select=id&limit=1`)
    let flightId: number
    if (existing?.length) {
      flightId = existing[0].id
    } else {
      const created = await sb('/flight_lookup', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ iata_number, airline_id: airline.id, source: 'admin_insert' }),
      })
      flightId = created[0].id
    }

    // 3. Upsert route_master — add days if entry already exists at same time
    const existRM = await sb(
      `/route_master?flight_id=eq.${flightId}&dep_iata=eq.${dep_iata}&arr_iata=eq.${arr_iata}&dep_time_utc=eq.${dep_time_utc}&select=id,days_of_week&limit=1`
    )

    if (existRM?.length) {
      const merged = [...new Set([...(existRM[0].days_of_week ?? []), ...days])]
      await sb(`/route_master?id=eq.${existRM[0].id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ days_of_week: merged, data_updated: new Date().toISOString() }),
      })
    } else {
      await sb('/route_master', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          flight_id:   flightId,
          airline_id:  airline.id,
          dep_iata,   arr_iata,
          dep_time:     addHours(dep_time_utc, 3),
          arr_time:     addHours(arr_time_utc, 3),
          dep_time_utc, arr_time_utc,
          duration_min: duration_min ?? null,
          days_of_week: days,
          source:       'admin_insert',
          active:       true,
          data_updated: new Date().toISOString(),
        }),
      })
    }

    // 4. Mark unfiled rows reviewed
    if (unfiled_ids?.length) {
      await sb(`/unfiled_flights?id=in.(${unfiled_ids.join(',')})`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ reviewed: true }),
      })
    }

    return NextResponse.json({ ok: true, airline_name: airline.name_en })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}

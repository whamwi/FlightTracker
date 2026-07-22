import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!

async function sb(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string>),
    },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

function normalizeRow(r: Record<string, unknown>) {
  const fl = r.flight_lookup as { iata_number: string; broadcast_callsign: string } | null
  return {
    id:                 r.id,
    iata_number:        fl?.iata_number ?? '',
    broadcast_callsign: fl?.broadcast_callsign ?? '',
    dep_iata:           r.dep_iata,
    arr_iata:           r.arr_iata,
    dep_time:           r.dep_time,
    arr_time:           r.arr_time,
    dep_time_utc:       r.dep_time_utc,
    arr_time_utc:       r.arr_time_utc,
    duration_min:       r.duration_min,
    days_of_week:       r.days_of_week,
    active:             r.active,
  }
}

const RM_SELECT =
  `id,dep_iata,arr_iata,dep_time,arr_time,dep_time_utc,arr_time_utc,duration_min,days_of_week,active` +
  `,flight_lookup!flight_id(iata_number,broadcast_callsign)`

// GET: returns unfilled and filled route_master rows
export async function GET() {
  const [unfilled, filled] = await Promise.all([
    sb(
      `/route_master?source=eq.damairport` +
      `&or=(dep_time.is.null,arr_time.is.null)` +
      `&select=${RM_SELECT}` +
      `&order=flight_lookup(iata_number).asc&limit=200`
    ),
    sb(
      `/route_master?source=eq.damairport` +
      `&dep_time=not.is.null&arr_time=not.is.null` +
      `&select=${RM_SELECT}` +
      `&order=flight_lookup(iata_number).asc&limit=500`
    ),
  ])

  return NextResponse.json({
    unfilled: (unfilled as Record<string, unknown>[]).map(r => ({ ...normalizeRow(r), missing: !r.dep_time ? 'dep' : 'arr' })),
    filled:   (filled   as Record<string, unknown>[]).map(normalizeRow),
  })
}

const AIRPORT_UTC_OFFSET: Record<string, number> = {
  DXB: 4, AUH: 4, SHJ: 4, MCT: 4, EVN: 4,
  AMS: 2, MJI: 2,
}
function utcToLocal(hhmm: string, iata: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const offsetMin = (AIRPORT_UTC_OFFSET[iata] ?? 3) * 60
  const local = ((h * 60 + m) + offsetMin) % 1440
  return `${String(Math.floor(local / 60)).padStart(2, '0')}:${String(local % 60).padStart(2, '0')}`
}

// POST: patch an existing row by id, or insert a new rotation
export async function POST(req: Request) {
  const body = await req.json() as {
    id?:          number | null   // present → PATCH; absent/null → INSERT
    flight_iata:  string
    dep_iata:     string
    arr_iata:     string
    dep_time_utc: string          // HH:MM
    arr_time_utc: string          // HH:MM
    days_of_week: string[]
  }

  const { id, flight_iata, dep_iata, arr_iata, dep_time_utc, arr_time_utc, days_of_week } = body

  const [depH, depM] = dep_time_utc.split(':').map(Number)
  const [arrH, arrM] = arr_time_utc.split(':').map(Number)
  const duration_min = ((arrH * 60 + arrM) - (depH * 60 + depM) + 1440) % 1440

  const times = {
    dep_time:     utcToLocal(dep_time_utc, dep_iata),
    dep_time_utc: dep_time_utc + ':00',
    arr_time:     utcToLocal(arr_time_utc, arr_iata),
    arr_time_utc: arr_time_utc + ':00',
    duration_min,
    data_updated: new Date().toISOString(),
    ...(days_of_week?.length ? { days_of_week } : {}),
  }

  if (id) {
    // PATCH by primary key — unambiguous even with multiple rotations per route
    await sb(`/route_master?id=eq.${id}`, {
      method:  'PATCH',
      headers: { Prefer: 'return=minimal' },
      body:    JSON.stringify(times),
    })
    return NextResponse.json({ ok: true, action: 'patched', id, duration_min })
  }

  // INSERT — new rotation for an existing flight+route
  const lookupRows: { id: number; airline_id: number }[] = await sb(
    `/flight_lookup?iata_number=eq.${flight_iata}&select=id,airline_id`
  )
  if (!lookupRows?.length) {
    return NextResponse.json({ ok: false, error: `flight_lookup not found: ${flight_iata}` }, { status: 404 })
  }
  const { id: flight_id, airline_id } = lookupRows[0]

  await sb('/route_master', {
    method:  'POST',
    headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
    body:    JSON.stringify({ flight_id, airline_id, dep_iata, arr_iata, source: 'manual', ...times }),
  })
  return NextResponse.json({ ok: true, action: 'inserted', flight_id, duration_min })
}

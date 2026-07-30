import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!

async function sb(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey:          SB_KEY,
      Authorization:   `Bearer ${SB_KEY}`,
      'Content-Type':  'application/json',
      ...(opts.headers as Record<string, string>),
    },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export async function GET() {
  const rows = await sb(
    '/unfiled_flights?select=*&order=flight_date.desc,diff_minutes.desc.nullslast'
  )
  return NextResponse.json({ ok: true, rows })
}

function addHours(t: string, h: number): string {
  const [hh, mm] = t.split(':').map(Number)
  const total = ((hh * 60 + mm) + h * 60 + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`
}

export async function PATCH(req: Request) {
  const { id, reviewed } = await req.json()
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

  // Fetch the row to check if it's a time_drift with a route_master entry to update
  const rows = await sb(`/unfiled_flights?id=eq.${id}&select=reason,route_master_id,sched_dep_utc,sched_arr_utc,duration_min&limit=1`)
  const row = rows?.[0]

  if (row?.reason === 'time_drift' && row.route_master_id && row.sched_dep_utc) {
    try {
      await sb(`/route_master?id=eq.${row.route_master_id}`, {
        method:  'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          dep_time_utc: row.sched_dep_utc,
          arr_time_utc: row.sched_arr_utc ?? null,
          dep_time:     addHours(row.sched_dep_utc, 3),
          arr_time:     row.sched_arr_utc ? addHours(row.sched_arr_utc, 3) : null,
          ...(row.duration_min != null ? { duration_min: row.duration_min } : {}),
          data_updated: new Date().toISOString(),
        }),
      })
    } catch (e) {
      return NextResponse.json({ ok: false, error: `route_master update failed: ${e}` }, { status: 409 })
    }
  }

  await sb(`/unfiled_flights?id=eq.${id}`, {
    method:  'PATCH',
    headers: { Prefer: 'return=minimal' },
    body:    JSON.stringify({ reviewed: reviewed ?? true }),
  })
  return NextResponse.json({ ok: true })
}

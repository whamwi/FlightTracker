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

export async function DELETE(req: Request) {
  const { ids } = await req.json()
  if (!ids?.length) return NextResponse.json({ ok: false, error: 'ids required' }, { status: 400 })
  await sb(`/unfiled_flights?id=in.(${ids.join(',')})`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  })
  return NextResponse.json({ ok: true })
}

/**
 * Airport local-time offsets, so a stored local time matches the clock at that airport.
 *
 * The old code added 3 hours to both ends. Correct for the Syrian side and wrong for the
 * other: an Abu Dhabi arrival would have been written an hour early, and route_master row 121
 * already holds arr_time 18:00 against arr_time_utc 14:00 — the +4 the previous data got
 * right and this would have silently corrupted on the first review.
 */
async function airportOffsets(iatas: string[]): Promise<Record<string, number>> {
  const list = [...new Set(iatas.filter(Boolean))]
  if (!list.length) return {}
  const rows = await sb(`/airports?iata=in.(${list.join(',')})&select=iata,utc_offset`)
  const out: Record<string, number> = {}
  for (const r of rows ?? []) if (r.utc_offset != null) out[r.iata] = Number(r.utc_offset)
  return out
}

type RmRow = {
  id: number
  flight_id: number | null
  airline_id: number | null
  dep_iata: string
  arr_iata: string
  dep_time_utc: string | null
  arr_time_utc: string | null
  duration_min: number | null
  days_of_week: string[] | null
  active: boolean
}

/**
 * Apply one day's drift to route_master.
 *
 * The previous version overwrote the row's times outright. A row covers several days —
 * 3L505 runs Mon, Wed, Fri and Sun on one row — so accepting Monday's new time silently
 * moved Wednesday, Friday and Sunday too. The next reconcile then flagged those three as
 * drifted, and correcting one day quietly broke three.
 *
 * So the day is split off instead:
 *
 *   1. If the row only covers this day, update it in place — nothing else is affected.
 *   2. Otherwise remove the day from that row, and either fold it into an existing row that
 *      already has the new time, or create one carrying just this day.
 *
 * The result is what the timetable actually says: one row per distinct time, each listing the
 * days it applies to.
 */
async function applyDrift(rm: RmRow, day: string, depUtc: string, arrUtc: string | null, durationMin: number | null) {
  const offsets = await airportOffsets([rm.dep_iata, rm.arr_iata])
  const depOff  = offsets[rm.dep_iata] ?? 3
  const arrOff  = offsets[rm.arr_iata] ?? 3

  const times = {
    dep_time_utc: depUtc,
    arr_time_utc: arrUtc ?? null,
    dep_time:     addHours(depUtc, depOff),
    arr_time:     arrUtc ? addHours(arrUtc, arrOff) : null,
    ...(durationMin != null ? { duration_min: durationMin } : {}),
    data_updated: new Date().toISOString(),
  }

  const days = rm.days_of_week ?? []

  // 1. This row is only about this day — safe to move it.
  if (days.length <= 1) {
    await sb(`/route_master?id=eq.${rm.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(times),
    })
    return { action: 'updated_in_place', row: rm.id }
  }

  // 2. Take the day off the existing row first. Done before the insert so that a failure
  //    here stops the whole operation rather than leaving the day on two rows at once,
  //    which would make the flight appear twice on the board.
  const remaining = days.filter(d => d !== day)
  await sb(`/route_master?id=eq.${rm.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ days_of_week: remaining, data_updated: new Date().toISOString() }),
  })

  // Is there already a row at the new time for this flight and route? Then this day joins it
  // rather than creating a second row saying the same thing.
  const siblings: RmRow[] = await sb(
    `/route_master?flight_id=eq.${rm.flight_id}` +
    `&dep_iata=eq.${rm.dep_iata}&arr_iata=eq.${rm.arr_iata}` +
    `&dep_time_utc=eq.${encodeURIComponent(depUtc)}&id=neq.${rm.id}&select=*`,
  ) ?? []

  if (siblings.length) {
    const sib = siblings[0]
    const merged = [...new Set([...(sib.days_of_week ?? []), day])]
    await sb(`/route_master?id=eq.${sib.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ days_of_week: merged, data_updated: new Date().toISOString() }),
    })
    return { action: 'merged_into_existing', row: sib.id, day, left_on: rm.id, remaining }
  }

  await sb('/route_master', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      flight_id:  rm.flight_id,
      airline_id: rm.airline_id,
      dep_iata:   rm.dep_iata,
      arr_iata:   rm.arr_iata,
      days_of_week: [day],
      active:     rm.active,
      source:     'reconcile_review',
      ...times,
    }),
  })
  return { action: 'split_new_row', day, left_on: rm.id, remaining }
}

export async function PATCH(req: Request) {
  const { id, reviewed } = await req.json()
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

  const rows = await sb(
    `/unfiled_flights?id=eq.${id}` +
    `&select=reason,route_master_id,day_of_week,sched_dep_utc,sched_arr_utc,duration_min&limit=1`,
  )
  const row = rows?.[0]

  let applied: unknown = null
  if (row?.reason === 'time_drift' && row.route_master_id && row.sched_dep_utc && row.day_of_week) {
    try {
      const rmRows: RmRow[] = await sb(`/route_master?id=eq.${row.route_master_id}&select=*`)
      const rm = rmRows?.[0]
      if (!rm) throw new Error(`route_master ${row.route_master_id} not found`)
      applied = await applyDrift(rm, row.day_of_week, row.sched_dep_utc, row.sched_arr_utc, row.duration_min)
    } catch (e) {
      // Reported rather than swallowed, and the unfiled row is deliberately NOT marked
      // reviewed: a drift that was not applied must stay on the list.
      return NextResponse.json(
        { ok: false, error: `route_master update failed: ${e instanceof Error ? e.message : String(e)}` },
        { status: 409 },
      )
    }
  }

  await sb(`/unfiled_flights?id=eq.${id}`, {
    method:  'PATCH',
    headers: { Prefer: 'return=minimal' },
    body:    JSON.stringify({ reviewed: reviewed ?? true }),
  })
  return NextResponse.json({ ok: true, applied })
}

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SB_URL   = process.env.SUPABASE_URL!
const SB_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!
const ADB_KEY  = process.env.AERODATABOX_KEY!
const ADB_BASE = 'https://prod.api.market/api/v1/aedbx/aerodatabox'

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

function utcToSyriaLocal(utcHHMM: string): string {
  const [h, m] = utcHHMM.split(':').map(Number)
  const localMin = ((h * 60 + m) + 180) % 1440
  return `${String(Math.floor(localMin / 60)).padStart(2, '0')}:${String(localMin % 60).padStart(2, '0')}`
}

function durMin(depUtc: string, arrUtc: string): number {
  return Math.round((new Date(arrUtc).getTime() - new Date(depUtc).getTime()) / 60_000)
}

interface AdbFlight {
  callSign?: string
  number?: string
  departure?: { airport?: { iata?: string }; scheduledTime?: { utc?: string } }
  arrival?:   { airport?: { iata?: string }; scheduledTime?: { utc?: string } }
}

// GET /api/sync/damairport/fill?date=YYYY-MM-DD
// Fills route_master rows that are still missing dep or arr time.
// Uses AeroDatBox real-time schedule data (DAM + ALP).
export async function GET(req: Request) {
  if (!ADB_KEY) {
    return NextResponse.json({ ok: false, error: 'AERODATABOX_KEY not set' }, { status: 500 })
  }

  const url  = new URL(req.url)
  const date = url.searchParams.get('date') ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)

  // ── 1. Load route_master rows missing one half ──────────────────────────────
  const schedRows: {
    id: number
    dep_time: string | null
    arr_time: string | null
    dep_time_utc: string | null
    arr_time_utc: string | null
    dep_iata: string
    arr_iata: string
    broadcast_callsign: string | null
    iata_number: string
  }[] = await sb(
    `/route_master?source=eq.damairport` +
    `&or=(dep_time.is.null,arr_time.is.null)` +
    `&select=id,dep_time,arr_time,dep_time_utc,arr_time_utc,dep_iata,arr_iata` +
    `,flight_lookup!flight_id(broadcast_callsign,iata_number)` +
    `&limit=200`
  ).then((rows: unknown[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows.map((r: any) => ({
      ...r,
      broadcast_callsign: r.flight_lookup?.broadcast_callsign ?? null,
      iata_number:        r.flight_lookup?.iata_number ?? '',
    }))
  )

  if (!schedRows.length) {
    return NextResponse.json({ ok: true, date, filled: 0, skipped: 0, note: 'No rows need filling' })
  }

  // ── 2. AeroDatBox fill ─────────────────────────────────────────────────────
  const windows = [
    [`${date}T00:00`, `${date}T12:00`],
    [`${date}T12:00`, `${date}T23:59`],
  ]
  const icaos = ['OSDI', 'OSAP']

  async function adbFetch(icao: string, from: string, to: string): Promise<AdbFlight[]> {
    const res = await fetch(
      `${ADB_BASE}/flights/airports/icao/${icao}/${from}/${to}?withLeg=true&withCancelled=false&direction=Both`,
      { headers: { 'x-api-market-key': ADB_KEY }, signal: AbortSignal.timeout(20_000) }
    )
    if (!res.ok) return []
    const data: { departures?: AdbFlight[]; arrivals?: AdbFlight[] } = await res.json()
    return [...(data.departures ?? []), ...(data.arrivals ?? [])]
  }

  const results = await Promise.allSettled(
    icaos.flatMap(icao => windows.map(([from, to]) => adbFetch(icao, from, to)))
  )
  const adbFlights: AdbFlight[] = results.flatMap(r => r.status === 'fulfilled' ? r.value : [])

  const byCallsign = new Map<string, AdbFlight>()
  const byIataNum  = new Map<string, AdbFlight>()
  for (const f of adbFlights) {
    if (f.callSign && !byCallsign.has(f.callSign))  byCallsign.set(f.callSign, f)
    if (f.number   && !byIataNum.has(f.number))     byIataNum.set(f.number.replace(/\s+/g, ''), f)
  }

  const patches: { id: number; patch: Record<string, string | number> }[] = []
  let skipped = 0

  for (const row of schedRows) {
    const adb = byCallsign.get(row.broadcast_callsign ?? '') ?? byIataNum.get(row.iata_number)
    if (!adb) { skipped++; continue }

    const adbDepUtc = adb.departure?.scheduledTime?.utc
    const adbArrUtc = adb.arrival?.scheduledTime?.utc
    if (!adbDepUtc || !adbArrUtc) { skipped++; continue }

    const depUtcHHMM = adbDepUtc.slice(11, 16)
    const arrUtcHHMM = adbArrUtc.slice(11, 16)
    const dur = durMin(adbDepUtc, adbArrUtc)
    if (dur <= 0) { skipped++; continue }

    const patch: Record<string, string | number> = { duration_min: dur }
    if (!row.dep_time) {
      patch.dep_time     = utcToSyriaLocal(depUtcHHMM)
      patch.dep_time_utc = depUtcHHMM + ':00'
    } else {
      patch.arr_time     = utcToSyriaLocal(arrUtcHHMM)
      patch.arr_time_utc = arrUtcHHMM + ':00'
    }
    patches.push({ id: row.id, patch })
  }

  if (patches.length) {
    await Promise.all(
      patches.map(u =>
        sb(`/route_master?id=eq.${u.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(u.patch),
        })
      )
    )
  }

  return NextResponse.json({
    ok: true,
    date,
    sched_rows: schedRows.length,
    adb_filled: patches.length,
    skipped,
  })
}

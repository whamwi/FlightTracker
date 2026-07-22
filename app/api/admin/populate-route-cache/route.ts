import { NextResponse } from 'next/server'

export const dynamic    = 'force-dynamic'
export const maxDuration = 60

const SB_URL    = process.env.SUPABASE_URL!
const SB_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!
const FR24_KEY  = process.env.FR24_API_KEY ?? ''
const FR24_BASE = 'https://fr24api.flightradar24.com'

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

// XH (Cham Wings) has no IATA on FR24 — tracked by FYC broadcast callsign.
const CALLSIGN_TO_IATA: Record<string, string> = {
  FYC701: 'XH701', FYC702: 'XH702', FYC705: 'XH705', FYC706: 'XH706',
  FYC741: 'XH741', FYC742: 'XH742', FYC744: 'XH744', FYC781: 'XH781',
}

// Default set: routes FR24 historical data covers well
const DEFAULT_IATA_FLIGHTS = ['DN541','DN542','FZ1191','FZ1192','J9181','J9182','RB341','RB342','RB389','RB390']
const DEFAULT_CALLSIGNS    = Object.keys(CALLSIGN_TO_IATA)

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

interface Fr24Summary {
  flight:           string | null
  callsign:         string | null
  orig_iata:        string | null
  dest_iata:        string | null
  datetime_takeoff: string | null
  datetime_landed:  string | null
  flight_time:      number | null
}

function isoToMin(iso: string): number {
  const [h, m] = iso.slice(11, 16).split(':').map(Number)
  return h * 60 + m
}

function medianNum(vals: number[]): number {
  if (!vals.length) return 0
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function minToHHMM(min: number): string {
  const w = ((min % 1440) + 1440) % 1440
  return `${String(Math.floor(w / 60)).padStart(2, '0')}:${String(w % 60).padStart(2, '0')}`
}

function utcToSyriaLocal(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const local = ((h * 60 + m) + 180) % 1440
  return `${String(Math.floor(local / 60)).padStart(2, '0')}:${String(local % 60).padStart(2, '0')}`
}

async function fr24Fetch(paramKey: 'flights' | 'callsigns', ids: string[], from: string, to: string): Promise<Fr24Summary[]> {
  const results: Fr24Summary[] = []
  const CHUNK = 10
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch  = ids.slice(i, i + CHUNK)
    const params = new URLSearchParams({ [paramKey]: batch.join(','), flight_datetime_from: from, flight_datetime_to: to, limit: '500' })
    try {
      const res = await fetch(`${FR24_BASE}/api/flight-summary/full?${params}`, {
        headers: { Accept: 'application/json', 'Accept-Version': 'v1', Authorization: `Bearer ${FR24_KEY}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) { console.error(`FR24 ${paramKey} ${batch.join(',')}: ${res.status}`); continue }
      const json = await res.json()
      const data: Fr24Summary[] = Array.isArray(json) ? json : (json.data ?? [])
      results.push(...data)
    } catch (e) { console.error('FR24 fetch error', e) }
  }
  return results
}

// GET /api/admin/populate-route-cache?days=14
// Queries FR24 historical flight summaries, computes median dep/arr/duration per route,
// and patches route_master rows directly.
export async function GET(req: Request) {
  if (!FR24_KEY) return NextResponse.json({ ok: false, error: 'FR24_API_KEY not set' }, { status: 500 })

  const url  = new URL(req.url)
  const days = parseInt(url.searchParams.get('days') ?? '14') || 14

  const now  = new Date()
  const from = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 19)
  const to   = now.toISOString().slice(0, 19)

  const [iataResults, callsignResults] = await Promise.all([
    fr24Fetch('flights',   DEFAULT_IATA_FLIGHTS, from, to),
    fr24Fetch('callsigns', DEFAULT_CALLSIGNS,    from, to),
  ])

  for (const r of callsignResults) {
    if (!r.flight && r.callsign) {
      const cs = r.callsign.replace(/\s+/g, '').toUpperCase()
      r.flight = CALLSIGN_TO_IATA[cs] ?? null
    }
  }

  const allSummaries = [...iataResults, ...callsignResults]

  type Occurrence = { dep_min: number; arr_min: number; dur_min: number; dow: string }
  const byRoute = new Map<string, Occurrence[]>()

  for (const s of allSummaries) {
    if (!s.datetime_takeoff || !s.datetime_landed) continue
    if (!s.orig_iata || !s.dest_iata) continue

    const flight   = (s.flight ?? '').replace(/\s+/g, '').toUpperCase()
    if (!flight) continue

    const dep_iata = s.orig_iata.toUpperCase()
    const arr_iata = s.dest_iata.toUpperCase()
    const key      = `${flight}|${dep_iata}|${arr_iata}`

    const dep_min = isoToMin(s.datetime_takeoff)
    const arr_min = isoToMin(s.datetime_landed)
    const dur_min = s.flight_time
      ? Math.round(s.flight_time / 60)
      : ((arr_min - dep_min + 1440) % 1440)
    const dow = DAY_NAMES[new Date(s.datetime_takeoff + 'Z').getUTCDay()]

    if (!byRoute.has(key)) byRoute.set(key, [])
    byRoute.get(key)!.push({ dep_min, arr_min, dur_min, dow })
  }

  if (!byRoute.size) {
    return NextResponse.json({
      ok:       true,
      from, to,
      summaries: allSummaries.length,
      patched:   0,
      note:     'No completed flights found — check if these routes operated in the date range',
    })
  }

  // Resolve flight_iata → flight_id for all routes found
  const flightIatas = [...new Set([...byRoute.keys()].map(k => k.split('|')[0]))]
  const lookupRows: { id: number; iata_number: string }[] = await sb(
    `/flight_lookup?iata_number=in.(${flightIatas.join(',')})&select=id,iata_number`
  )
  const lookupById = new Map(lookupRows.map(l => [l.iata_number, l.id]))

  const patches: Promise<unknown>[] = []
  const patched: object[] = []

  for (const [key, occurrences] of byRoute) {
    const [flight_iata, dep_iata, arr_iata] = key.split('|')
    const flight_id = lookupById.get(flight_iata)
    if (!flight_id) continue

    const dep_time_utc = minToHHMM(medianNum(occurrences.map(o => o.dep_min)))
    const arr_time_utc = minToHHMM(medianNum(occurrences.map(o => o.arr_min)))
    const duration_min = medianNum(occurrences.map(o => o.dur_min))
    const days_of_week = [...new Set(occurrences.map(o => o.dow))].sort()

    const patch = {
      dep_time:     utcToSyriaLocal(dep_time_utc),
      dep_time_utc: dep_time_utc + ':00',
      arr_time:     utcToSyriaLocal(arr_time_utc),
      arr_time_utc: arr_time_utc + ':00',
      duration_min,
      days_of_week,
      data_updated: now.toISOString(),
    }

    patched.push({ flight_iata, dep_iata, arr_iata, ...patch })
    patches.push(
      sb(`/route_master?flight_id=eq.${flight_id}&dep_iata=eq.${dep_iata}&arr_iata=eq.${arr_iata}`, {
        method:  'PATCH',
        headers: { Prefer: 'return=minimal' },
        body:    JSON.stringify(patch),
      })
    )
  }

  await Promise.all(patches)

  return NextResponse.json({
    ok:        true,
    from, to,
    summaries: allSummaries.length,
    patched:   patched.length,
    routes:    patched,
  })
}

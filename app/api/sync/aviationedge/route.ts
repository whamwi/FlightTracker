import { NextResponse } from 'next/server'

export const dynamic  = 'force-dynamic'
export const maxDuration = 60

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!
const AE_KEY  = process.env.AVIATION_EDGE_KEY
const AE_BASE = 'https://aviation-edge.com/v2/public/timetable'

// Local UTC offsets (summer, Syria/Gulf). Covers every airport in our route_master.
const TZ_OFFSET: Record<string, number> = {
  DAM: 3, ALP: 3,
  DXB: 4, AUH: 4, SHJ: 4, MCT: 4,
  DOH: 3, KWI: 3, RUH: 3, JED: 3, DMM: 3,
  AMM: 3, BGW: 3, EBL: 3,
  IST: 3, SAW: 3, ESB: 3,
  EVN: 4, AMS: 2,
}

const STATUS_MAP: Record<string, string> = {
  scheduled: 'scheduled',
  active:    'airborne',
  landed:    'landed',
  cancelled: 'cancelled',
  diverted:  'diverted',
}

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

// Convert a LOCAL datetime string ("2026-07-24T01:05:00.000") to UTC ISO string.
// Treats the string as local time for the given IATA airport.
function localToUtc(local: string | null | undefined, iata: string): string | null {
  if (!local) return null
  const offset = TZ_OFFSET[iata] ?? 3
  // Parse as UTC, then subtract the local offset to get real UTC
  const dt = new Date(local.slice(0, 19) + 'Z')
  dt.setUTCHours(dt.getUTCHours() - offset)
  return dt.toISOString()
}

// Extract YYYY-MM-DD from a LOCAL datetime string (the local date IS the flight date).
function localDate(local: string): string {
  return local.slice(0, 10)
}

type AeRecord = {
  type:       string
  status:     string
  codeshared: unknown  // present on codeshare records — we skip these
  departure: {
    iataCode:      string
    scheduledTime: string
    estimatedTime?: string | null
    actualTime?:    string | null
  }
  arrival: {
    iataCode:       string
    scheduledTime?: string | null
    estimatedTime?: string | null
    actualTime?:    string | null
  }
  airline: { iataCode: string; icaoCode: string }
  flight:  { number: string | null; iataNumber: string; icaoNumber: string }
}

async function fetchAe(iata: string, type: 'departure' | 'arrival'): Promise<AeRecord[]> {
  const res = await fetch(`${AE_BASE}?key=${AE_KEY}&iataCode=${iata}&type=${type}`)
  if (!res.ok) return []
  const json = await res.json()
  return Array.isArray(json) ? json : []
}

type UpdateSpec = {
  flight_id:   number
  flight_date: string
  dep_iata:    string
  arr_iata:    string
  etd?:  string | null
  eta?:  string | null
  atd?:  string | null
  ata?:  string | null
  status?: string
}

export async function GET() {
  if (!AE_KEY) {
    return NextResponse.json({ ok: false, error: 'AVIATION_EDGE_KEY not set' }, { status: 503 })
  }

  // ── 1. Load flight_lookup cache ─────────────────────────────────────────
  const lookupRows: { id: number; iata_number: string; broadcast_callsign: string | null }[] =
    await sb('/flight_lookup?select=id,iata_number,broadcast_callsign&limit=500')

  const byIata     = new Map<string, number>()
  const byCallsign = new Map<string, number>()
  for (const l of lookupRows) {
    if (l.iata_number)        byIata.set(l.iata_number.toUpperCase(), l.id)
    if (l.broadcast_callsign) byCallsign.set(l.broadcast_callsign.toUpperCase(), l.id)
  }

  // ── 2. Fetch from Aviation Edge in parallel ──────────────────────────────
  const [damDep, damArr, alpDep, alpArr] = await Promise.all([
    fetchAe('DAM', 'departure'),
    fetchAe('DAM', 'arrival'),
    fetchAe('ALP', 'departure'),
    fetchAe('ALP', 'arrival'),
  ])

  const aeTotal = damDep.length + damArr.length + alpDep.length + alpArr.length

  // ── 3. Match records to flight_lookup and build update specs ────────────
  const updatesMap = new Map<string, UpdateSpec>()

  function matchFlight(rec: AeRecord): number | null {
    const iata = rec.flight.iataNumber?.toUpperCase()
    const icao = rec.flight.icaoNumber?.toUpperCase()
    if (iata && byIata.has(iata)) return byIata.get(iata)!
    if (icao && byCallsign.has(icao)) return byCallsign.get(icao)!
    return null
  }

  function processRecord(rec: AeRecord) {
    // Skip codeshare duplicates (e.g. WY5232/RJ436 for the same AMM flight)
    if ((rec as Record<string, unknown>).codeshared) return
    // Skip ghost records with no flight number
    if (!rec.flight.number) return

    const flight_id = matchFlight(rec)
    if (!flight_id) return

    const depIata = rec.departure.iataCode
    const arrIata = rec.arrival.iataCode
    if (!rec.departure.scheduledTime) return

    const flight_date = localDate(rec.departure.scheduledTime)
    const key = `${flight_id}|${flight_date}|${depIata}`

    const spec: UpdateSpec = updatesMap.get(key) ?? { flight_id, flight_date, dep_iata: depIata, arr_iata: arrIata }

    if (rec.departure.estimatedTime) spec.etd = localToUtc(rec.departure.estimatedTime, depIata)
    if (rec.departure.actualTime)    spec.atd = localToUtc(rec.departure.actualTime, depIata)

    if (rec.arrival.estimatedTime)   spec.eta = localToUtc(rec.arrival.estimatedTime, arrIata)
    if (rec.arrival.actualTime)      spec.ata = localToUtc(rec.arrival.actualTime, arrIata)

    if (rec.status) spec.status = STATUS_MAP[rec.status] ?? rec.status

    updatesMap.set(key, spec)
  }

  // Departure queries first so they win on status if arrival also returns the flight
  for (const rec of [...damDep, ...alpDep, ...damArr, ...alpArr]) processRecord(rec)

  if (updatesMap.size === 0) {
    return NextResponse.json({ ok: true, ae_total: aeTotal, matched: 0, updated: 0 })
  }

  // ── 4. Load matching flight_instance rows ────────────────────────────────
  const specs       = [...updatesMap.values()]
  const flightIds   = [...new Set(specs.map(s => s.flight_id))]
  const flightDates = [...new Set(specs.map(s => s.flight_date))]

  const instances: { id: number; flight_id: number; flight_date: string; dep_iata: string }[] =
    await sb(
      `/flight_instance` +
      `?flight_id=in.(${flightIds.join(',')})` +
      `&flight_date=in.(${flightDates.join(',')})` +
      `&select=id,flight_id,flight_date,dep_iata`
    )

  const instanceById = new Map(
    instances.map(i => [`${i.flight_id}|${i.flight_date}|${i.dep_iata}`, i.id])
  )

  // ── 5. PATCH each matched instance ───────────────────────────────────────
  const now = new Date().toISOString()
  let updated = 0
  let unmatched = 0

  await Promise.all(
    specs.map(async ({ flight_id, flight_date, dep_iata, arr_iata, ...fields }) => {
      const key        = `${flight_id}|${flight_date}|${dep_iata}`
      const instanceId = instanceById.get(key)
      if (!instanceId) { unmatched++; return }

      // Only send non-null fields — don't overwrite a real value with null
      const patch: Record<string, unknown> = { updated_at: now }
      if (fields.etd  !== undefined && fields.etd  !== null) patch.etd  = fields.etd
      if (fields.eta  !== undefined && fields.eta  !== null) patch.eta  = fields.eta
      if (fields.atd  !== undefined && fields.atd  !== null) patch.atd  = fields.atd
      if (fields.ata  !== undefined && fields.ata  !== null) patch.ata  = fields.ata
      if (fields.status)                                      patch.status = fields.status

      await sb(`/flight_instance?id=eq.${instanceId}`, {
        method:  'PATCH',
        headers: { Prefer: 'return=minimal' },
        body:    JSON.stringify(patch),
      })
      updated++
    })
  )

  return NextResponse.json({
    ok: true,
    ae_total:  aeTotal,
    ae_breakdown: { damDep: damDep.length, damArr: damArr.length, alpDep: alpDep.length, alpArr: alpArr.length },
    matched:   specs.length - unmatched,
    updated,
    unmatched,
  })
}

export const POST = GET

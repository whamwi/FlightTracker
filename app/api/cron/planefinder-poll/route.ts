import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_ANON_KEY!
const PF_KEY  = process.env.PLANEFINDER_API_KEY!
const PF_BASE = 'https://api.planefinder.net/api/v1'

const SB_HEADERS = {
  apikey:         SB_KEY,
  Authorization:  `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
}

interface ActiveFlight {
  callsign:    string
  flight_date: string
  std:         string
  sta:         string
  dep_iata:    string | null
  arr_iata:    string | null
}

interface DbStatus {
  status:         string | null
  actual_dep_utc: string | null
  actual_arr_utc: string | null
  last_synced_at: string | null
}

interface PfLive {
  callsign:         string | null
  reg:              string | null
  type:             string | null
  departureAirport: string | null
  arrivalAirport:   string | null
  flightNumber:     string | null
  altitude:         number | null
  speed:            number | null
  lastSeen:         number | null
}

// All active flights in window — all airlines, no callsign filter.
async function getActiveFlights(now: Date): Promise<ActiveFlight[]> {
  const plus30    = new Date(now.getTime() + 30 * 60_000).toISOString()
  const minus90   = new Date(now.getTime() - 90 * 60_000).toISOString()
  const yesterday = new Date(now.getTime() - 24 * 3_600_000).toISOString().slice(0, 10)

  const params = new URLSearchParams({
    select:      'flight_date,std,sta,status,dep_iata,arr_iata,flight_lookup(broadcast_callsign)',
    flight_date: `gte.${yesterday}`,
    std:         `lte.${plus30}`,
    sta:         `gte.${minus90}`,
    status:      'neq.arrived',
  })

  const res = await fetch(`${SB_URL}/rest/v1/flight_instance?${params}`, { headers: SB_HEADERS })
  if (!res.ok) throw new Error(`flight_instance query failed: ${res.status}`)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await res.json()
  return rows
    .filter(r => !!r.flight_lookup?.broadcast_callsign)
    .map(r => ({
      callsign:    r.flight_lookup.broadcast_callsign as string,
      flight_date: r.flight_date as string,
      std:         r.std as string,
      sta:         r.sta as string,
      dep_iata:    r.dep_iata ?? null,
      arr_iata:    r.arr_iata ?? null,
    }))
}

// Fetch current flight_status for active flights, keyed by `callsign_date`.
async function getFlightStatuses(flights: ActiveFlight[]): Promise<Map<string, DbStatus>> {
  if (flights.length === 0) return new Map()

  const callsigns = [...new Set(flights.map(f => f.callsign))]
  const dates     = [...new Set(flights.map(f => f.flight_date))]

  const params = new URLSearchParams({
    select:         'callsign,operating_date,status,actual_dep_utc,actual_arr_utc,last_synced_at',
    callsign:       `in.(${callsigns.join(',')})`,
    operating_date: `in.(${dates.join(',')})`,
  })
  const res = await fetch(`${SB_URL}/rest/v1/flight_status?${params}`, { headers: SB_HEADERS })
  if (!res.ok) return new Map()

  const rows: {
    callsign: string; operating_date: string; status: string | null
    actual_dep_utc: string | null; actual_arr_utc: string | null; last_synced_at: string | null
  }[] = await res.json()

  return new Map(rows.map(r => [`${r.callsign}_${r.operating_date}`, {
    status:         r.status,
    actual_dep_utc: r.actual_dep_utc,
    actual_arr_utc: r.actual_arr_utc,
    last_synced_at: r.last_synced_at,
  }]))
}

// Poll Planefinder live — 10 credits/call when results, 1 when empty.
async function fetchPfLive(callsigns: string[]): Promise<PfLive[]> {
  const url = new URL(`${PF_BASE}/live/aircraft`)
  url.searchParams.set('callsign', callsigns.join(','))

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${PF_KEY}` },
    signal:  AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    console.error(`[pf-poll] live ${res.status}`, await res.text())
    return []
  }
  const body = await res.json()
  return (body?.data ?? []) as PfLive[]
}

// Planefinder historic — 25 credits. Returns firstSeen (departure) and lastSeen (arrival).
async function fetchPfHistoric(
  callsign: string,
  flightDate: string,
): Promise<{ firstSeen: string | null; lastSeen: string | null }> {
  const base = Math.floor(new Date(`${flightDate}T00:00:00Z`).getTime() / 1000)
  const url  = new URL(`${PF_BASE}/historic/flights`)
  url.searchParams.set('callsign', callsign)
  url.searchParams.set('from', String(base - 12 * 3600))
  url.searchParams.set('to',   String(base + 36 * 3600))

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${PF_KEY}` },
    signal:  AbortSignal.timeout(10_000),
  })
  if (!res.ok) return { firstSeen: null, lastSeen: null }

  const body = await res.json()
  const records: { firstSeen: number; lastSeen: number | null }[] = body?.data ?? []
  if (records.length === 0) return { firstSeen: null, lastSeen: null }

  const best = records.reduce((a, b) => (a.firstSeen > b.firstSeen ? a : b))
  return {
    firstSeen: new Date(best.firstSeen * 1000).toISOString(),
    lastSeen:  best.lastSeen ? new Date(best.lastSeen * 1000).toISOString() : null,
  }
}

async function upsertStatus(row: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${SB_URL}/rest/v1/flight_status`, {
    method:  'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify(row),
  })
  if (!res.ok) throw new Error(`flight_status upsert failed: ${res.status} ${await res.text()}`)
}

export async function GET(req: Request) {
  const auth = req.headers.get('Authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  if (!PF_KEY) {
    return NextResponse.json({ ok: false, error: 'PLANEFINDER_API_KEY not configured' }, { status: 503 })
  }

  const now = new Date()
  const log: string[] = []

  // ── 1. Active flights from schedule ──────────────────────────────────────
  const active = await getActiveFlights(now)
  log.push(`active flights: ${active.length}`)
  if (active.length === 0) return NextResponse.json({ ok: true, log, active: 0, live: 0 })

  // ── 2. Current DB status ──────────────────────────────────────────────────
  const dbStatuses = await getFlightStatuses(active)

  // ── 3. Poll Planefinder live in batches of 10 ─────────────────────────────
  const liveMap      = new Map<string, PfLive>()
  const allCallsigns = active.map(f => f.callsign)
  let   liveCredits  = 0

  for (let i = 0; i < allCallsigns.length; i += 10) {
    const batch   = allCallsigns.slice(i, i + 10)
    const results = await fetchPfLive(batch)
    for (const r of results) { if (r.callsign) liveMap.set(r.callsign, r) }
    liveCredits += results.length > 0 ? 10 : 1
    log.push(`batch ${Math.floor(i / 10) + 1}: [${batch.join(',')}] → ${results.length} live`)
  }

  // ── 4. Process each flight ─────────────────────────────────────────────────
  const ops: Promise<void>[] = []
  let   historicCalls = 0

  for (const flight of active) {
    const { callsign, flight_date, std, sta, dep_iata, arr_iata } = flight
    const pf = liveMap.get(callsign)
    const db = dbStatuses.get(`${callsign}_${flight_date}`)

    const dbStatus     = db?.status ?? null
    const hasActualDep = !!db?.actual_dep_utc
    const hasActualArr = !!db?.actual_arr_utc
    const isEnRoute    = dbStatus === 'En Route' || dbStatus === 'Approaching'
    const isDeparted   = dbStatus === 'Departed'
    const isTerminal   = dbStatus === 'Landed' || dbStatus === 'Arrived'
    const lastSyncMs   = db?.last_synced_at ? new Date(db.last_synced_at).getTime() : 0
    const minSinceSync = (now.getTime() - lastSyncMs) / 60_000
    const pastStd20    = now.getTime() > new Date(std).getTime() + 20 * 60_000
    const pastSta      = now.getTime() > new Date(sta).getTime()

    if (isTerminal) {
      log.push(`${callsign}: ${dbStatus} — skip`)
      continue
    }

    if (pf) {
      // ── A: Visible in live → En Route ─────────────────────────────────────
      ops.push(
        upsertStatus({
          callsign,
          operating_date:    flight_date,
          status:            'En Route',
          dep_iata:          pf.departureAirport ?? dep_iata,
          arr_iata:          pf.arrivalAirport   ?? arr_iata,
          flight_number:     pf.flightNumber ?? null,
          aircraft_reg:      pf.reg  ?? null,
          aircraft_type:     pf.type ?? null,
          airline_icao:      callsign.slice(0, 3),
          scheduled_dep_utc: std,
          scheduled_arr_utc: sta,
          ...(!hasActualDep ? { actual_dep_utc: now.toISOString() } : {}),
          last_synced_at:    now.toISOString(),
        }).then(() => {
          const from = !isEnRoute ? ` (↑ from ${dbStatus ?? 'Scheduled'})` : ''
          log.push(`${callsign}: En Route${from}`)
        })
      )

    } else if (isEnRoute && !hasActualArr && pastSta && minSinceSync >= 20) {
      // ── B1: Was live in Planefinder, now gone, past STA → 20-min grace then historic
      historicCalls++
      ops.push(
        fetchPfHistoric(callsign, flight_date).then(async ({ lastSeen }) => {
          const staMs      = new Date(sta).getTime()
          const lastSeenMs = lastSeen ? new Date(lastSeen).getTime() : 0
          const confirmed  = !!lastSeen && lastSeenMs >= staMs - 30 * 60_000
          if (confirmed) {
            await upsertStatus({
              callsign,
              operating_date: flight_date,
              status:         'Landed',
              actual_arr_utc: lastSeen!,
              last_synced_at: now.toISOString(),
            })
            log.push(`${callsign}: Landed (ata=${lastSeen})`)
          } else {
            await upsertStatus({ callsign, operating_date: flight_date, last_synced_at: now.toISOString() })
            log.push(`${callsign}: signal lost mid-flight (lastSeen=${lastSeen ?? 'none'}, sta=${sta}) — keep tracking`)
          }
        })
      )

    } else if (isDeparted && !hasActualArr && pastSta) {
      // ── B2: Confirmed departed (never seen live), past STA → historic immediately
      historicCalls++
      ops.push(
        fetchPfHistoric(callsign, flight_date).then(async ({ lastSeen }) => {
          const staMs      = new Date(sta).getTime()
          const lastSeenMs = lastSeen ? new Date(lastSeen).getTime() : 0
          const confirmed  = !!lastSeen && lastSeenMs >= staMs - 30 * 60_000
          if (confirmed) {
            await upsertStatus({
              callsign,
              operating_date: flight_date,
              status:         'Landed',
              actual_arr_utc: lastSeen!,
              last_synced_at: now.toISOString(),
            })
            log.push(`${callsign}: Landed (ata=${lastSeen})`)
          } else {
            await upsertStatus({ callsign, operating_date: flight_date, last_synced_at: now.toISOString() })
            log.push(`${callsign}: no arrival confirmed yet (lastSeen=${lastSeen ?? 'none'}) — retry next cycle`)
          }
        })
      )

    } else if (!hasActualDep && pastStd20 && minSinceSync >= 60) {
      // ── C: No departure yet, past STD+20min → historic to confirm departure (retry max once/hr)
      historicCalls++
      ops.push(
        fetchPfHistoric(callsign, flight_date).then(async ({ firstSeen, lastSeen }) => {
          if (firstSeen) {
            const staMs      = new Date(sta).getTime()
            const lastSeenMs = lastSeen ? new Date(lastSeen).getTime() : 0
            const landed     = !!lastSeen && lastSeenMs >= staMs - 30 * 60_000
            await upsertStatus({
              callsign,
              operating_date:    flight_date,
              status:            landed ? 'Landed' : 'Departed',
              actual_dep_utc:    firstSeen,
              ...(landed ? { actual_arr_utc: lastSeen } : {}),
              dep_iata,
              arr_iata,
              airline_icao:      callsign.slice(0, 3),
              scheduled_dep_utc: std,
              scheduled_arr_utc: sta,
              last_synced_at:    now.toISOString(),
            })
            log.push(`${callsign}: ${landed ? `Landed (atd=${firstSeen} ata=${lastSeen})` : `Departed (atd=${firstSeen})`}`)
          } else {
            // No PF data — throttle retry via last_synced_at
            await upsertStatus({
              callsign,
              operating_date: flight_date,
              status:         dbStatus ?? 'Expected',
              last_synced_at: now.toISOString(),
            })
            log.push(`${callsign}: past STD+20 but no PF data (delayed?)`)
          }
        })
      )

    } else {
      log.push(`${callsign}: ${dbStatus ?? 'Scheduled'} — waiting (std+20: ${pastStd20}, ${Math.round(minSinceSync)}min since sync)`)
    }
  }

  await Promise.all(ops)

  const creditsEst = liveCredits + historicCalls * 25
  log.push(`credits est: ${creditsEst} (live=${liveCredits}, historic=${historicCalls}×25)`)

  // ── 5. Write to cron_log ───────────────────────────────────────────────────
  await fetch(`${SB_URL}/rest/v1/cron_log`, {
    method:  'POST',
    headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
    body:    JSON.stringify({
      cron:          'planefinder-poll',
      ran_at:        now.toISOString(),
      active:        active.length,
      live:          liveMap.size,
      historic_calls: historicCalls,
      credits_est:   creditsEst,
      log:           log,
    }),
  })

  return NextResponse.json({ ok: true, log, active: active.length, live: liveMap.size, credits_est: creditsEst })
}

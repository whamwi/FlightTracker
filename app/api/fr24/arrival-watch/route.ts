import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const FR24_KEY  = process.env.FR24_API_KEY ?? ''
const SB_URL    = process.env.SUPABASE_URL!
const SB_KEY    = process.env.SUPABASE_ANON_KEY!

// Static airport coordinates for distance check (lat, lon)
const AIRPORT_COORDS: Record<string, [number, number]> = {
  DAM: [33.4115,  36.5156],
  ALP: [36.1807,  37.2244],
  DXB: [25.2532,  55.3657],
  SHJ: [25.3286,  55.5172],
  AUH: [24.4330,  54.6511],
  IST: [41.2608,  28.7418],
  SAW: [40.8983,  29.3092],
  ESB: [40.1282,  32.9951],
  AYT: [36.8987,  30.8008],
  CAI: [30.1219,  31.4056],
  AMM: [31.7226,  35.9932],
  BEY: [33.8209,  35.4883],
  KWI: [29.2267,  47.9689],
  DOH: [25.2609,  51.6138],
  MCT: [23.5933,  58.2844],
  BGW: [33.2625,  44.2346],
  TBS: [41.6693,  44.9547],
  GZP: [36.3002,  32.3001],
  RUH: [24.9578,  46.6989],
  JED: [21.6796,  39.1565],
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Compute projected landing time from last known position + altitude.
// Uses two independent estimates and takes the larger (most conservative):
//   • Altitude-based: remaining_alt / standard_descent_rate
//   • Distance-based: remaining_km / approach_speed
// Returns ISO string, or null if data is insufficient.
function projectEta(c: Candidate): string | null {
  if (!c.seen_at || c.alt_baro == null) return null
  const seenAt = new Date(c.seen_at).getTime()
  const ageMs  = Date.now() - seenAt
  if (ageMs > 40 * 60_000) return null           // signal too stale to project from
  if (c.alt_baro > 15_000)  return null           // still too high — too early to project

  // Altitude-based: ~1,500 ft/min standard approach descent rate
  const altMin = c.alt_baro / 1_500

  // Distance-based: speed bracket by altitude (kts → km/min)
  let distMin: number | null = null
  const arrCoords = c.arr_iata ? AIRPORT_COORDS[c.arr_iata] : null
  if (c.lat != null && c.lon != null && arrCoords) {
    const km = haversineKm(c.lat, c.lon, arrCoords[0], arrCoords[1])
    const speedKts = c.alt_baro > 8_000 ? 280 : c.alt_baro > 3_000 ? 220 : 160
    const speedKmMin = speedKts * 1.852 / 60
    distMin = km / speedKmMin
  }

  const timeToLandMin = distMin != null ? Math.max(altMin, distMin) : altMin
  const etaMs = seenAt + timeToLandMin * 60_000
  return new Date(etaMs).toISOString()
}

interface Candidate {
  callsign:       string
  arr_iata:       string | null
  actual_dep_utc: string
  status:         string | null
  best_arr_utc:   string | null
  lat:            number | null
  lon:            number | null
  alt_baro:       number | null
  seen_at:        string | null
}

interface ChecklistResult {
  callsign:  string
  triggered: boolean
  reasons:   string[]
  skipped?:  string
}

function runChecklist(c: Candidate, now: Date): ChecklistResult {
  const reasons: string[] = []

  // ── Gate: must be in arrival window ──────────────────────────────────────
  if (c.best_arr_utc) {
    const sta     = new Date(c.best_arr_utc).getTime()
    const windowStart = sta - 30 * 60_000
    const windowEnd   = sta + 90 * 60_000
    if (now.getTime() < windowStart) {
      return { callsign: c.callsign, triggered: false, reasons: [], skipped: 'too early — outside arrival window' }
    }
    if (now.getTime() > windowEnd) {
      return { callsign: c.callsign, triggered: false, reasons: [], skipped: 'too late — past 90-min window' }
    }
  } else {
    // No STA at all — use 4h from departure as a conservative fallback
    const dep  = new Date(c.actual_dep_utc).getTime()
    const age  = (now.getTime() - dep) / 3_600_000
    if (age < 0.5) return { callsign: c.callsign, triggered: false, reasons: [], skipped: 'departed < 30 min ago' }
    if (age > 6)   return { callsign: c.callsign, triggered: false, reasons: [], skipped: 'departed > 6h ago, no STA — stale' }
  }

  const seenMs  = c.seen_at  ? now.getTime() - new Date(c.seen_at).getTime() : null
  const seenMin = seenMs != null ? seenMs / 60_000 : null
  const arrCoords = c.arr_iata ? AIRPORT_COORDS[c.arr_iata] : null

  // ── Trigger A: low altitude + fresh signal ────────────────────────────────
  if (c.alt_baro != null && c.alt_baro < 5_000 && seenMin != null && seenMin < 20) {
    reasons.push(`A: alt ${c.alt_baro}ft < 5,000 and seen ${Math.round(seenMin)}min ago`)
  }

  // ── Trigger B: within 80 km of destination ────────────────────────────────
  if (c.lat != null && c.lon != null && arrCoords) {
    const km = haversineKm(c.lat, c.lon, arrCoords[0], arrCoords[1])
    if (km < 80) {
      reasons.push(`B: ${Math.round(km)}km from ${c.arr_iata}`)
    }
  }

  // ── Trigger C: signal dropped on short final (stale + was low) ───────────
  if (seenMin != null && seenMin > 15 && c.alt_baro != null && c.alt_baro < 8_000) {
    reasons.push(`C: signal stale ${Math.round(seenMin)}min, last alt ${c.alt_baro}ft`)
  }

  // ── Trigger D: ADB already signalled approach/arrival ────────────────────
  if (c.status === 'Approaching' || c.status === 'Arrived') {
    reasons.push(`D: ADB status = ${c.status}`)
  }

  return { callsign: c.callsign, triggered: reasons.length > 0, reasons }
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!FR24_KEY) return NextResponse.json({ ok: false, error: 'FR24_API_KEY not set' }, { status: 500 })

  const now = new Date()

  // ── 1. Fetch candidates: departed, no arrival, recent operating date ──────
  const candidateRes = await fetch(
    `${SB_URL}/rest/v1/rpc/get_arrival_watch_candidates`,
    {
      method: 'POST',
      headers: {
        apikey:         SB_KEY,
        Authorization:  `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    },
  )

  if (!candidateRes.ok) {
    return NextResponse.json({ ok: false, error: `DB candidates fetch: ${candidateRes.status}` }, { status: 502 })
  }

  const candidates: Candidate[] = await candidateRes.json()

  // ── 2. Run checklist on each candidate ───────────────────────────────────
  const results = candidates.map(c => runChecklist(c, now))
  const toQuery = results.filter(r => r.triggered).map(r => r.callsign)
  const skipped = results.filter(r => !r.triggered)

  if (toQuery.length === 0) {
    return NextResponse.json({
      ok: true, checked: candidates.length, triggered: 0,
      updated: 0, skipped: skipped.map(r => ({ callsign: r.callsign, reason: r.skipped ?? 'no trigger' })),
    })
  }

  // ── 3. Query FR24 for triggered flights ───────────────────────────────────
  const from = new Date(now.getTime() - 36 * 3_600_000).toISOString().slice(0, 19)
  const to   = now.toISOString().slice(0, 19)

  const params = new URLSearchParams({ callsigns: toQuery.join(','), flight_datetime_from: from, flight_datetime_to: to })
  const fr24Res = await fetch(`https://fr24api.flightradar24.com/api/flight-summary/full?${params}`, {
    headers: {
      Accept:           'application/json',
      'Accept-Version': 'v1',
      Authorization:    `Bearer ${FR24_KEY}`,
    },
    signal: AbortSignal.timeout(12_000),
  })

  if (!fr24Res.ok) {
    return NextResponse.json({ ok: false, error: `FR24 ${fr24Res.status}: ${await fr24Res.text()}` }, { status: 502 })
  }

  const fr24Json = await fr24Res.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fr24Data: any[] = Array.isArray(fr24Json) ? fr24Json : (fr24Json.data ?? [])

  // ── 4a. Upsert confirmed landings ────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const landed    = fr24Data.filter((r: any) => r.datetime_landed)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fr24ByCs  = Object.fromEntries(fr24Data.map((r: any) => [r.callsign, r]))
  let updated     = 0
  let etaProjected = 0

  if (landed.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = landed.map((r: any) => ({
      callsign:       r.callsign,
      operating_date: (r.datetime_takeoff ?? r.datetime_landed).slice(0, 10),
      actual_arr_utc: r.datetime_landed.endsWith('Z') ? r.datetime_landed : `${r.datetime_landed}Z`,
      arr_iata:       r.dest_iata_actual ?? r.dest_iata ?? null,
      arr_icao:       r.dest_icao_actual ?? r.dest_icao ?? null,
      status:         'Landed',
      last_synced_at: now.toISOString(),
    }))

    const sbRes = await fetch(`${SB_URL}/rest/v1/flight_status`, {
      method: 'POST',
      headers: {
        apikey:         SB_KEY,
        Authorization:  `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer:         'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    })

    if (!sbRes.ok) {
      return NextResponse.json({ ok: false, error: `DB upsert landed: ${await sbRes.text()}` }, { status: 500 })
    }
    updated = landed.length
  }

  // ── 4b. flight_ended:true + no datetime_landed → mark arrived via last_seen ─
  // FR24 knows the flight is over but never got a runway touchdown (common when
  // ADS-B coverage drops before landing — e.g. Syria). Use last_seen + 6 min
  // buffer as the best available arrival estimate.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const endedNoLanding = fr24Data.filter((r: any) => r.flight_ended && !r.datetime_landed && r.last_seen)
  if (endedNoLanding.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const endedRows = endedNoLanding.map((r: any) => {
      const approxArr = new Date(new Date(r.last_seen + 'Z').getTime() + 6 * 60_000).toISOString()
      return {
        callsign:       r.callsign,
        operating_date: (r.datetime_takeoff ?? r.last_seen).slice(0, 10),
        actual_arr_utc: approxArr,
        arr_iata:       r.dest_iata_actual ?? r.dest_iata ?? null,
        arr_icao:       r.dest_icao_actual ?? r.dest_icao ?? null,
        status:         'Arrived',
        last_synced_at: now.toISOString(),
      }
    })
    const endedRes = await fetch(`${SB_URL}/rest/v1/flight_status`, {
      method: 'POST',
      headers: {
        apikey:         SB_KEY,
        Authorization:  `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer:         'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(endedRows),
    })
    if (endedRes.ok) updated += endedNoLanding.length
    endedNoLanding.forEach((r: any) => landedCallsigns.add(r.callsign))
  }

  // ── 4c. Project ETA for triggered flights with no confirmed landing ────────
  // For flights in approach phase where FR24 has no datetime_landed yet,
  // compute estimated arrival from last known altitude + distance and store
  // as revised_arr_utc so the board/map can show it immediately.
  const etaRows: object[] = []
  const landedCallsigns = new Set(landed.map((r: any) => r.callsign))

  for (const callsign of toQuery) {
    if (landedCallsigns.has(callsign)) continue            // confirmed landed or ended — skip
    const candidate = candidates.find(c => c.callsign === callsign)
    if (!candidate) continue
    const eta = projectEta(candidate)
    if (!eta) continue
    etaRows.push({
      callsign,
      operating_date: candidate.actual_dep_utc.slice(0, 10),
      revised_arr_utc: eta,
      last_synced_at: now.toISOString(),
    })
  }

  if (etaRows.length > 0) {
    const etaRes = await fetch(`${SB_URL}/rest/v1/flight_status`, {
      method: 'POST',
      headers: {
        apikey:         SB_KEY,
        Authorization:  `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer:         'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(etaRows),
    })
    if (etaRes.ok) etaProjected = etaRows.length
  }

  return NextResponse.json({
    ok:            true,
    checked:       candidates.length,
    triggered:     toQuery.length,
    updated,
    eta_projected: etaProjected,
    checklist: results.map(r => ({
      callsign:  r.callsign,
      triggered: r.triggered,
      reasons:   r.reasons,
      skipped:   r.skipped,
    })),
    fr24_returned:    fr24Data.length,
    landed_callsigns: [...landedCallsigns],
    eta_callsigns:    etaRows.map((r: any) => `${r.callsign} → ${r.revised_arr_utc}`),
  })
}

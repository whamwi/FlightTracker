import { NextResponse } from 'next/server'
import { sweepAllCircles } from '@/lib/adsb-feed'

/**
 * Owns the ADS-B sweep so nothing else has to.
 *
 * /api/airspace used to fetch the five circles from the request path, cached per lambda
 * instance. Under load every new instance ran its own sweep, and adsb.fi allows roughly one
 * request a second — a few dozen concurrent instances is enough to earn a 429 and then a
 * block, taking the map dark for everyone. This writes positions to Supabase instead, so
 * upstream traffic is constant whether ten people are watching or ten thousand.
 *
 * Vercel schedules crons at a one-minute granularity, so a single invocation does several
 * sweeps spaced inside its own lifetime rather than being scheduled more often. Freshness
 * costs nothing visually anyway: the map derives position from the stored route path and
 * schedule and only lets the feed *correct the rate*, so a 20-second-old fix looks the same
 * as a 5-second-old one.
 *
 * `raw` keeps the whole feed object. The response ships these straight to the client, which
 * reads fields this table has no columns for — t, r, track, true_heading among them — and
 * once the cron is the only writer, anything not stored is simply lost.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const SB_URL     = process.env.SUPABASE_URL!
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

// No gap between sweeps: a sweep already takes ~14s on its own — five circles spaced 1.1s
// apart, plus request time — so back-to-back sweeps produce a ~14s cadence by themselves.
// Adding a 14s gap on top made the first version run ~98s and time out.
//
// Bounded by a deadline rather than a count, so a slow feed cannot push the invocation past
// its limit: a run that manages two sweeps is fine, one that gets killed writes nothing.
const MAX_SWEEPS   = 4
const DEADLINE_MS  = 45_000

/* eslint-disable @typescript-eslint/no-explicit-any */
async function writePositions(aircraft: any[]): Promise<number> {
  if (!aircraft.length) return 0
  const now = new Date().toISOString()
  const rows = aircraft.map(a => ({
    hex:            a.hex,
    callsign:       (a.flight ?? '').trim() || null,
    lat:            a.lat,
    lon:            a.lon,
    alt_baro:       typeof a.alt_baro === 'number' ? a.alt_baro : null,
    gs:             a.gs    ?? null,
    track:          a.track ?? null,
    aircraft_type:  a.t     ?? null,
    registration:   a.r     ?? null,
    syria_airports: [],
    seen_at:        now,
    first_seen_at:  now,
    first_lat:      a.lat,
    first_lon:      a.lon,
    first_alt:      typeof a.alt_baro === 'number' ? a.alt_baro : null,
    raw:            a,
  }))

  let written = 0
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200)
    const res = await fetch(`${SB_URL}/rest/v1/aircraft_last_seen?on_conflict=hex`, {
      method:  'POST',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body:    JSON.stringify(batch),
    })
    // Checked, not fire-and-forget. A silently failing write here looks exactly like an
    // empty sky to the read path, and that is the failure this whole change exists to avoid.
    if (res.ok) written += batch.length
    else console.error('[airspace-poll] write failed', res.status, (await res.text()).slice(0, 200))
  }
  return written
}

export async function GET() {
  const started = Date.now()
  const sweeps: { aircraft: number; written: number; circlesOk: number; live: boolean }[] = []

  for (let i = 0; i < MAX_SWEEPS; i++) {
    if (Date.now() - started > DEADLINE_MS) break
    try {
      const { aircraft, live, circlesOk } = await sweepAllCircles()
      const written = await writePositions(aircraft)
      sweeps.push({ aircraft: aircraft.length, written, circlesOk, live })
    } catch (e) {
      console.error('[airspace-poll] sweep failed', String(e))
      sweeps.push({ aircraft: 0, written: 0, circlesOk: 0, live: false })
    }
  }

  const totalSeen = sweeps.reduce((n, s) => n + s.aircraft, 0)
  const blind     = sweeps.every(s => !s.live)
  if (blind) console.error('[airspace-poll] every sweep blind — all circles failed')

  return NextResponse.json({
    ok: !blind,
    sweeps,
    totalSeen,
    elapsedMs: Date.now() - started,
  })
}

import { NextResponse } from 'next/server'
import { sweepAllCircles } from '@/lib/adsb-feed'
import { logSignals, syriaOpDate } from '@/lib/signal-log'
import { inSyria } from '@/lib/syria-airspace'

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

/**
 * A margin around the Syria polygon, in degrees.
 *
 * The read path keeps `board_match || inSyria`, so the polygon alone would be enough for what
 * is drawn right now — but the stored rows are the fallback for when every feed is down, and
 * an aircraft two minutes from the border needs to already be there when it crosses. One
 * degree is roughly 110 km, comfortably more than a poll cycle of flying.
 */
const STORE_MARGIN_DEG = 1.0

const inStoreRegion = (lat: number, lon: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lon)
  && lat >= 32.0 - STORE_MARGIN_DEG && lat <= 37.7 + STORE_MARGIN_DEG
  && lon >= 35.3 - STORE_MARGIN_DEG && lon <= 42.7 + STORE_MARGIN_DEG

/**
 * The callsigns the board knows, so a flight of ours is kept wherever it is.
 *
 * Fetched once per invocation rather than per sweep — it is 163 rows and changes when a route
 * is added, not between sweeps fourteen seconds apart.
 */
async function boardCallsigns(): Promise<Set<string>> {
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/flight_lookup?select=broadcast_callsign&broadcast_callsign=not.is.null`,
      { headers: SB_HEADERS, cache: 'no-store' },
    )
    if (!res.ok) return new Set()
    return new Set((await res.json() as { broadcast_callsign: string }[])
      .map(r => r.broadcast_callsign.trim().toUpperCase()))
  } catch {
    return new Set()
  }
}

// Surfaced in the GET response so a failing write can be seen without log access — the table
// staying empty while every other signal looked healthy is what made the first attempt hard to
// diagnose.
let lastSignalNote = 'not run'

/* eslint-disable @typescript-eslint/no-explicit-any */
async function writePositions(aircraft: any[], ours: Set<string>): Promise<number> {
  /*
   * Store what could be drawn, not the whole sweep.
   *
   * The five circles reach from Morocco to Iran, and every aircraft in them was being
   * upserted every fourteen seconds. Measured on 2026-08-08: 17,931 airframes held, 131
   * inside Syria, and 14 with a callsign the board has ever known. The other 99.3% was
   * written, indexed, vacuumed and pruned without ever being read — 75 million updates, and
   * two seen_at indexes bloated to 137 MB against a 27 MB heap.
   *
   * The rule matches the read path's `board_match || inSyria`, with a margin so an aircraft
   * is already stored before it crosses the border.
   */
  const keep = aircraft.filter(a =>
    inStoreRegion(a.lat, a.lon) || ours.has((a.flight ?? '').trim().toUpperCase()))
  aircraft = keep

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

  /*
   * Position history and flight milestones, from the same sweep.
   *
   * These rows were written by visitors' browsers, which meant two production paths depended on
   * somebody watching: cron/carry-over reads flight_signal_log.airborne_at to spot a carried-over
   * flight that is really flying, and /api/airspace reads flight_position_log for fixes that are
   * often a flight's only ones. Measured before moving it — five consecutive hours on 14 Aug with
   * no rows at all, because nobody had the map open.
   *
   * dep_iata and arr_iata are null here. They come from board matching, which happens in
   * /api/airspace at request time and has no business running in a sweep; no consumer on the read
   * path selects them. The browser used to supply them, which is why every historical row has one
   * — a useful tell for telling the two eras apart later.
   */
  /*
   * Only flights that could be ours — the board's callsigns, or anything over Syria.
   *
   * The same rule the read path applies (`board_match || inSyria`), and it has to be applied here
   * too. The browser this replaced logged only the flights it was already tracking; the sweep sees
   * the whole region, so logging everything with a callsign put foreign overflights into
   * flight_signal_log. /api/airspace reads that table for confirmed-airborne flights and emits
   * them with board_match hardcoded true, so on 15 Aug five aircraft — BBG692, MEA251, ETD76T,
   * JAV281, FDB34Q — were drawn on the map with no origin and no destination.
   *
   * Storing them was never the intent: this table exists to give our flights a position when the
   * sweep misses them, not to be a regional traffic log.
   */
  const opDate = syriaOpDate(Date.parse(now))
  const readings = rows
    .filter(r => r.callsign
      && (ours.has(r.callsign.trim().toUpperCase()) || inSyria(r.lat, r.lon)))
    .map(r => ({
      callsign:    r.callsign as string,
      flight_date: opDate,
      lat: r.lat, lon: r.lon,
      alt_baro: r.alt_baro, gs: r.gs, track: r.track,
      hex: r.hex ?? null,
      dep_iata: null, arr_iata: null,
    }))
  if (readings.length > 0) {
    try { lastSignalNote = `ok ${await logSignals(readings, now)}` }
    catch (e) { lastSignalNote = String(e).slice(0, 300); console.error('[airspace-poll] signal log failed', e) }
  } else {
    lastSignalNote = 'no readings'
  }

  return written
}

export async function GET() {
  const started = Date.now()
  const sweeps: { aircraft: number; written: number; circlesOk: number; live: boolean }[] = []
  const ours   = await boardCallsigns()

  for (let i = 0; i < MAX_SWEEPS; i++) {
    if (Date.now() - started > DEADLINE_MS) break
    try {
      const { aircraft, live, circlesOk } = await sweepAllCircles()
      const written = await writePositions(aircraft, ours)
      sweeps.push({ aircraft: aircraft.length, written, circlesOk, live })
    } catch (e) {
      console.error('[airspace-poll] sweep failed', String(e))
      sweeps.push({ aircraft: 0, written: 0, circlesOk: 0, live: false })
    }
  }

  const totalSeen = sweeps.reduce((n, s) => n + s.aircraft, 0)
  const totalWrit = sweeps.reduce((n, s) => n + s.written, 0)
  const blind     = sweeps.length === 0 || sweeps.every(s => !s.live)
  if (blind) console.error('[airspace-poll] every sweep blind — all circles failed')

  // One row per invocation. aircraft_last_seen cannot answer "did the poller run?" — it is
  // upserted by hex, so it only ever holds an aircraft's latest sighting, and a minute that
  // never ran looks identical to a minute whose aircraft were all seen again later. Absence
  // is the failure worth catching, so it gets its own record. Best-effort: a failed log write
  // must not fail the poll that actually matters.
  await fetch(`${SB_URL}/rest/v1/airspace_poll_log`, {
    method:  'POST',
    headers: { ...SB_HEADERS, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      sweeps:     sweeps.length,
      aircraft:   totalSeen,
      written:    totalWrit,
      circles_ok: sweeps.length ? sweeps[sweeps.length - 1].circlesOk : 0,
      blind,
      elapsed_ms: Date.now() - started,
    }),
  }).catch(e => console.error('[airspace-poll] log write failed', String(e)))

  return NextResponse.json({
    ok: !blind,
    sweeps,
    totalSeen,
    signalLog: lastSignalNote,
    elapsedMs: Date.now() - started,
  })
}

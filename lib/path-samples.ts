/**
 * Cross-track sampling — the recording half of route self-learning.
 *
 * Every board-matched flight is projected onto the stored corridor for its OD pair, and how
 * far it sat from that corridor is written down. Enough of those, across enough flights, and
 * the places where the stored geometry is simply wrong become obvious: not from one aircraft
 * deviating, which happens constantly for weather and ATC, but from every aircraft deviating
 * the same way at the same point.
 *
 * CROSS-TRACK ONLY, deliberately.
 *
 * The drift visible on the map mixes two unrelated errors, and only one of them is about
 * geometry:
 *
 *   cross-track  the aircraft is flying a different corridor than the stored waypoints.
 *                The path is wrong. This is the learnable one.
 *   along-track  the marker is ahead of or behind the aircraft on a perfectly good path.
 *                That is a timing fault -- a wrong duration, a stale ETA, a slow climb.
 *
 * Both bugs found on 3 August were along-track: one flight ran ahead on a correct path
 * because the tracker seeded from elapsed time during a climb, another crawled because its
 * duration arrived as 1578 minutes instead of 180. Feeding either into a geometry learner
 * would have rewritten a correct route to chase a clock problem. So this reads `offPathKm`
 * from the projection and never the distance between drawn and actual position.
 *
 * Sampling is restricted to cruise (see CRUISE_*). Departure and arrival manoeuvring leaves
 * the corridor by design -- vectors, holds, runway in use -- and is not evidence that the
 * corridor is wrong.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { PathGeometry } from './path-tracker.ts'
import type { Waypoint } from './flight-predictor.ts'

/**
 * Below these an aircraft is climbing out or descending, where leaving the stored corridor
 * is normal and says nothing about whether the corridor is right.
 */
export const CRUISE_MIN_ALT_FT = 10_000
export const CRUISE_MIN_GS_KTS = 150
/** A fix older than this has moved on; projecting it puts the sample in the wrong place. */
export const MAX_FIX_AGE_MS = 60_000

export interface RoutePathRow {
  dep_iata: string
  arr_iata: string
  variant: number | null
  waypoints: Waypoint[]
}

export interface PathSample {
  callsign:    string
  dep_iata:    string
  arr_iata:    string
  variant:     number | null
  s:           number
  lat:         number
  lon:         number
  off_path_km: number
  gs_kts:      number | null
  alt_ft:      number | null
  flight_date: string
  seen_at:     string
}

/** Geometry per corridor, built once per run rather than per aircraft. */
export function indexPaths(rows: RoutePathRow[]): Map<string, { variant: number | null; geo: PathGeometry }[]> {
  const out = new Map<string, { variant: number | null; geo: PathGeometry }[]>()
  for (const r of rows) {
    if (!r.dep_iata || !r.arr_iata || !Array.isArray(r.waypoints) || r.waypoints.length < 2) continue
    const geo = new PathGeometry(r.waypoints)
    if (!geo.usable) continue
    const key = `${r.dep_iata}|${r.arr_iata}`
    const list = out.get(key) ?? []
    list.push({ variant: r.variant, geo })
    out.set(key, list)
  }
  return out
}

/** Why an aircraft produced no sample. Kept so a run that records nothing can say why. */
export type SkipReason =
  | 'not_board_matched' | 'no_route' | 'no_path' | 'no_position'
  | 'not_cruise' | 'stale_fix'

export interface SampleResult {
  samples: PathSample[]
  skipped: Record<SkipReason, number>
}

export function buildSamples(aircraft: any[], paths: ReturnType<typeof indexPaths>, nowMs: number): SampleResult {
  const samples: PathSample[] = []
  const skipped: Record<SkipReason, number> = {
    not_board_matched: 0, no_route: 0, no_path: 0, no_position: 0, not_cruise: 0, stale_fix: 0,
  }

  for (const a of aircraft) {
    const cs = (a?.flight ?? '').trim()
    if (!cs || !a?.board_match) { skipped.not_board_matched++; continue }
    if (!a.dep_iata || !a.arr_iata) { skipped.no_route++; continue }
    if (typeof a.lat !== 'number' || typeof a.lon !== 'number') { skipped.no_position++; continue }

    const alt = typeof a.alt_baro === 'number' ? a.alt_baro : null
    const gs  = typeof a.gs === 'number' ? a.gs : null
    if (alt === null || alt < CRUISE_MIN_ALT_FT || gs === null || gs < CRUISE_MIN_GS_KTS) {
      skipped.not_cruise++; continue
    }

    // `seen` is seconds since the fix was received.
    const ageMs = typeof a.seen === 'number' ? a.seen * 1000 : 0
    if (ageMs > MAX_FIX_AGE_MS) { skipped.stale_fix++; continue }

    const variants = paths.get(`${a.dep_iata}|${a.arr_iata}`)
    if (!variants?.length) { skipped.no_path++; continue }

    // Score every corridor and keep the best fit, so a route flown on two corridors does not
    // average into one matching neither — the same rule the live tracker applies.
    let best: { variant: number | null; s: number; offPathKm: number } | null = null
    for (const v of variants) {
      const p = v.geo.project(a.lat, a.lon)
      if (!best || p.offPathKm < best.offPathKm) {
        best = { variant: v.variant, s: p.sDist, offPathKm: p.offPathKm }
      }
    }
    if (!best) { skipped.no_path++; continue }

    const seenAtMs = nowMs - ageMs
    samples.push({
      callsign:    cs,
      dep_iata:    a.dep_iata,
      arr_iata:    a.arr_iata,
      variant:     best.variant,
      s:           best.s,
      lat:         a.lat,
      lon:         a.lon,
      off_path_km: best.offPathKm,
      gs_kts:      gs,
      alt_ft:      alt,
      // The operating day, used to count how many distinct legs agree. Taken from the fix,
      // not from "today", so a sample near midnight is attributed to the right flight.
      flight_date: new Date(seenAtMs).toISOString().slice(0, 10),
      seen_at:     new Date(seenAtMs).toISOString(),
    })
  }

  return { samples, skipped }
}

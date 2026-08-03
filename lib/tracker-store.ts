/**
 * Holds one PathTracker per airborne flight and answers "where is it right now".
 *
 * This is what lets the map animate. The poll loop only *feeds* the store — a position
 * fix when one arrives, a revised arrival estimate when it changes — and never sets a
 * marker's position directly. Position comes from asking the store on every animation
 * frame, which it can answer at any instant because progress is a scalar advancing at a
 * known rate rather than a fix to be interpolated between.
 *
 * That inverts the current arrangement, where positions are computed inside the 10-second
 * poll and markers therefore step. Here the poll cadence stops being visible at all: a
 * late or missing fix changes the rate slightly, not the motion.
 */

import {
  PathTracker,
  DEFAULT_PATH_CONFIG,
  type PathConfig,
  type PathContext,
  type PathFix,
  type PathPosition,
  type FixOutcome,
} from './path-tracker.ts'
import type { Waypoint } from './flight-predictor.ts'

export interface FlightInput {
  callsign:       string
  /** Known corridors for this OD pair, most-observed first. May be empty. */
  variants:       Waypoint[][]
  dep_coords:     [number, number]
  arr_coords:     [number, number]
  departed_at_ms: number | null
  /** Revised arrival when known, else scheduled. Drives the rate. */
  eta_ms:         number | null
  duration_ms:    number | null
  /** Latest observed position, if one has been seen. */
  fix?:           PathFix | null
  /** Diagnostic only: which code path produced this input. Ignored by the store. */
  src?:           'live' | 'sched'
}

export class TrackerStore {
  private trackers = new Map<string, PathTracker>()
  /** Timestamp of the last fix applied per flight, so a repeated poll is not re-applied. */
  private lastFixAt = new Map<string, number>()
  private lastEta   = new Map<string, number | null>()
  private cfg: PathConfig
  /**
   * Outcome of the most recent fix offered per flight.
   *
   * applyFix already reports whether it accepted the fix and by how much the fix disagreed,
   * but update() had no way to surface it, so a rejected fix was silent. That matters because
   * progress is monotonic: once a tracker runs ahead of the aircraft, every subsequent real
   * fix is behind it and gets rejected as 'backward', and the error is locked in until the
   * tracker is rebuilt. This is what makes that visible.
   */
  private lastOutcome = new Map<string, FixOutcome & { at_ms: number }>()

  constructor(cfg: PathConfig = DEFAULT_PATH_CONFIG) {
    this.cfg = cfg
  }

  /**
   * Reconcile the store with the current set of airborne flights.
   *
   * Anything absent from `inputs` is dropped, so landed flights do not linger.
   */
  update(inputs: FlightInput[], nowMs: number): void {
    const seen = new Set<string>()

    for (const f of inputs) {
      seen.add(f.callsign)
      let t = this.trackers.get(f.callsign)

      if (!t) {
        const ctx: PathContext = {
          variants:       f.variants,
          dep_coords:     f.dep_coords,
          arr_coords:     f.arr_coords,
          departed_at_ms: f.departed_at_ms,
          eta_ms:         f.eta_ms,
          duration_ms:    f.duration_ms,
        }
        t = new PathTracker(ctx, nowMs, this.cfg)
        this.trackers.set(f.callsign, t)
        this.lastEta.set(f.callsign, f.eta_ms)
      } else if (f.eta_ms !== this.lastEta.get(f.callsign)) {
        // A revised arrival is a rate change, not a position change.
        t.setEta(f.eta_ms, nowMs)
        this.lastEta.set(f.callsign, f.eta_ms)
      }

      // Only offer genuinely new fixes; the poll returns the same one until it moves.
      if (f.fix && f.fix.at_ms !== this.lastFixAt.get(f.callsign)) {
        this.lastFixAt.set(f.callsign, f.fix.at_ms)
        const outcome = t.applyFix(f.fix, nowMs)
        this.lastOutcome.set(f.callsign, { ...outcome, at_ms: f.fix.at_ms })
      }
    }

    for (const cs of [...this.trackers.keys()]) {
      if (!seen.has(cs)) this.drop(cs)
    }
  }

  /** Where the flight is at this instant. Safe to call every animation frame. */
  position(callsign: string, nowMs: number): PathPosition | null {
    return this.trackers.get(callsign)?.position(nowMs) ?? null
  }

  has(callsign: string): boolean {
    return this.trackers.has(callsign)
  }

  callsigns(): string[] {
    return [...this.trackers.keys()]
  }

  drop(callsign: string): void {
    this.trackers.delete(callsign)
    this.lastFixAt.delete(callsign)
    this.lastEta.delete(callsign)
    this.lastOutcome.delete(callsign)
  }

  clear(): void {
    this.trackers.clear()
    this.lastFixAt.clear()
    this.lastEta.clear()
    this.lastOutcome.clear()
  }

  /** How the last offered fix was handled: accepted, or rejected and by how far. */
  outcome(callsign: string) {
    return this.lastOutcome.get(callsign) ?? null
  }

  /** Per-flight diagnostics — rejection tallies, corridor choice, synthesised paths. */
  snapshot(callsign: string) {
    return this.trackers.get(callsign)?.snapshot() ?? null
  }
}

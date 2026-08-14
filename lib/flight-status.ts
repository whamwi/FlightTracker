/**
 * Has this flight arrived, and what should we call its state — asked once, for every surface.
 *
 * The question was being answered in four places with four rules, and on 14 Aug 2026 two of them
 * disagreed with the server on the same morning:
 *
 *   FYC492  board said Arrived (actual_arr 02:59:11), the live feed said landed, and the map drew
 *           it "~ In air" — because the map required its schedule projection to be complete, and
 *           the aircraft had landed at 76% of the projected block. It arrived early; the map had
 *           no way to notice.
 *
 *   RJA431  the mirror image. Its projection completed at 02:38 with no arrival published, so the
 *           map drew "~ In air" until FR24 backfilled at 02:57 — nineteen minutes after landing,
 *           and three hours on a day FR24 stays silent, which at Aleppo is 22 arrivals in 35.
 *
 * Both came from one line, `fraction >= 1.0 && confirmedArr`, which is only right when the
 * projection and the confirmation happen to agree.
 *
 * As of 14 Aug the client stops deriving this at all. The server decides — it is the only place
 * holding every input: real_arr, arr_confirmed_at, est_arr, the block and the live positions —
 * and every surface renders that one answer.
 *
 * The client used to run its own stopwatch, departure plus block plus fifteen minutes, and that
 * was the trouble. Sharing a function is not sharing an answer: on 14 Aug the panel was given a
 * flight's last fix age and the popup and marker were not, so the same rule returned different
 * results on the same flight in the same second. FAD742 flipped to Arrived on the card while its
 * marker sat 45 km from Jeddah.
 *
 * What is left here is a reading of the server's word plus the one fact a client can be certain
 * of: an actual arrival time it was handed.
 */

/** FR24 spells the same state more than one way. */
const STATUS_ALIAS: Record<string, string> = { Landed: 'Arrived', Land: 'Arrived' }

/**
 * The minimum a caller must know. Structural rather than a named Flight type, because the three
 * callers hold three different shapes — the board's Flight, the map panel's InAirFlight, and the
 * map's ScheduleEntry plus FlightStatus — and the point of this module is that they stop mattering.
 */
export type StatusFacts = {
  status?: string | null
  actual_arr_utc?: string | null
  actual_dep_utc?: string | null
  revised_arr_utc?: string | null
  duration_min?: number | null
  /**
   * Seconds since we last saw this aircraft airborne, from a real fix — never F-EST.
   *
   * Optional, and absent means "no opinion" rather than "not flying": most callers have no
   * position to offer and must keep the behaviour they had.
   */
  airborne_fix_age_s?: number | null
}


/**
 * True when the flight is on the ground at its destination.
 *
 * An actual arrival ends the flight outright, whatever a projection says. That single clause is
 * what FYC492 needed; everything after it is for flights with no arrival time at all.
 */
export function hasArrived(f: StatusFacts, _nowMs: number = Date.now()): boolean {
  if (f.actual_arr_utc) return true
  const s = STATUS_ALIAS[f.status ?? ''] ?? f.status
  return s === 'Arrived'
}

/** The word a surface shows. Cancelled and Diverted outrank everything: the flight is not coming. */
export function effectiveStatus(f: StatusFacts, nowMs: number = Date.now()): string {
  const s = STATUS_ALIAS[f.status ?? ''] ?? f.status ?? 'Unknown'
  if (s === 'Cancelled' || s === 'Diverted') return s
  if (hasArrived(f, nowMs)) return 'Arrived'
  if (f.actual_dep_utc) return s !== 'Unknown' ? s : 'Departed'
  if (f.revised_arr_utc && (s === 'Scheduled' || s === 'Unknown')) return 'Expected'
  return s
}

/**
 * How long after landing a flight still outranks tomorrow's copy of itself.
 *
 * Four hours, matching the window `boardDeparted` already uses to keep an arrived flight on the
 * map. Beyond it the arrival is history and tomorrow's departure is the more useful instance.
 */
const ARRIVED_RELEVANT_MS = 4 * 3_600_000

/**
 * Which instance of a repeating flight number is the one to show.
 *
 * A daily rotation appears on several of the dates the map fetches, and only one may be drawn.
 * Ranked by what a reader is looking for right now:
 *
 *   3  airborne          — the flight in the sky wins outright
 *   2  landed recently   — still worth showing; the marker has not expired yet
 *   1  not yet departed  — tomorrow's copy, or today's later leg
 *   0  landed long ago   — history, and tomorrow is the better answer
 *
 * Rank 2 is what was missing. The rule was `arrived ? 0 : departed ? 2 : 1`, which put every
 * completed flight below tomorrow's untouched row — so on 14 Aug the map drew ABY433 and THY848
 * from their 15 Aug rows: no actual times, no registration, and for THY848 the wrong aircraft
 * type (73J against the A332 that actually operated). Every popup defect on those two traced
 * back to being handed a flight that had not happened yet.
 *
 * Airborne still outranks everything, which is the case this ranking was written for: FZ1192 was
 * nearly down at Dubai while the map held its next-day row and stamped a departure time in the
 * future onto it.
 */
export function rankInstance(f: StatusFacts, nowMs: number = Date.now()): number {
  if (f.actual_dep_utc && !f.actual_arr_utc) return 3
  if (f.actual_arr_utc) {
    const arr = Date.parse(f.actual_arr_utc)
    return Number.isFinite(arr) && nowMs - arr < ARRIVED_RELEVANT_MS ? 2 : 0
  }
  return 1
}

/**
 * Minutes a flight differs from its filed time — negative when early.
 *
 * The scheduled side is a bare HH:MM with no date, so an overnight leg would otherwise read as a
 * 24-hour delay: a flight due 23:50 and landing 00:05 is fifteen minutes late, not 1,425 early.
 * Twelve hours is the widest gap treated as a same-day comparison.
 *
 * Shared because the map's side card had no equivalent and printed bare times, while the board
 * printed the same times with their variance beside them.
 */
export function calcDelay(schedHHMM: string | null | undefined, actualISO: string | null | undefined): number | null {
  if (!actualISO || !schedHHMM) return null
  const actualMs = Date.parse(actualISO)
  if (!Number.isFinite(actualMs)) return null
  let schedMs = Date.parse(`${actualISO.slice(0, 10)}T${schedHHMM}:00Z`)
  if (!Number.isFinite(schedMs)) return null
  if (schedMs - actualMs > 12 * 3_600_000) schedMs -= 86_400_000
  return Math.round((actualMs - schedMs) / 60_000)
}

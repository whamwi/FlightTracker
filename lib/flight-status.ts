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
 * The rule below is the board's, which two of the three surfaces already used, and it is the
 * conservative one: it never calls a flight arrived before an actual time says so or the block
 * plus a grace period has fully elapsed. Adopting it makes the map slower to claim an arrival and
 * never earlier — the right direction, given that FR24's frozen estimates ran 16 and 19 minutes
 * early on the two flights measured that morning.
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
}

/**
 * How long after the scheduled block elapses before an unconfirmed flight is called arrived.
 *
 * Fifteen minutes, inherited from the board. It absorbs a block that runs slightly long without
 * leaving a landed aircraft drawn in the air, and it is deliberately not tuned against the
 * estimate — an estimate frozen at the moment a track died is the thing least worth trusting here.
 */
const ARRIVAL_GRACE_MS = 15 * 60_000

/**
 * True when the flight is on the ground at its destination.
 *
 * An actual arrival ends the flight outright, whatever a projection says. That single clause is
 * what FYC492 needed; everything after it is for flights with no arrival time at all.
 */
export function hasArrived(f: StatusFacts, nowMs: number = Date.now()): boolean {
  if (f.actual_arr_utc) return true
  const s = STATUS_ALIAS[f.status ?? ''] ?? f.status
  if (s === 'Arrived') return true
  if (s === 'Cancelled' || s === 'Diverted') return false
  if (f.actual_dep_utc && f.duration_min) {
    const dep = Date.parse(f.actual_dep_utc)
    if (Number.isFinite(dep) && dep + f.duration_min * 60_000 + ARRIVAL_GRACE_MS < nowMs) return true
  }
  return false
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

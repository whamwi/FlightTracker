import { translate } from './i18n.ts'
import { getActiveLocale } from './geo-data.ts'
import type { PopupStatus } from './flight-popup.ts'

/**
 * V3's STATUS, decided from the server's phase.
 *
 * This used to render a whole popup of its own, which was a mistake: a different popup on each
 * map confounds the very comparison the v2/v3 toggle exists to make, and the second one was
 * poorer — it dropped the progress bar, the local times at both airports, the distance remaining,
 * the aircraft type and the photo. Both maps now render lib/flight-popup, and only this is
 * different.
 *
 * ── Why it is not V2's builder ──
 *
 * V2's buildPopup takes an Aircraft AND a FlightStatus and reconciles them — two sources with
 * their own ideas of the flight number, the route and whether it has landed. It then works the
 * status out for itself from timestamps: arrived if hasArrived(), else signal-lost if the
 * predictor lost the track, else projected if it is dead-reckoning, else in air.
 *
 * That reconciliation is where the map learned to disagree with the board. ABY433 on 14 Aug read
 * "signal lost" under a marker labelled ARRIVED; THY848 read "~ in air" with its landing time
 * printed underneath it. Each branch was individually right and the popup as a whole was wrong.
 *
 * Here there is one source. /v2/live already decided the phase, using the same fix the marker is
 * drawn from — so the words and the position cannot contradict each other, because they are the
 * same answer read twice.
 *
 * ── What that removes ──
 *
 * ARRIVED IS UNREACHABLE, and that is the point rather than an omission. The server withholds the
 * position of an arrived flight, so it has no marker, so there is no popup to open. V2 needed an
 * arrived branch precisely because it kept drawing flights the server had finished with.
 *
 * SIGNAL LOST IS GONE TOO. It described the predictor's state, not the aeroplane's — it meant
 * "we are dead-reckoning now". Nothing here dead-reckons. A fix that has stopped arriving is
 * reported as what it is: the age of what we last saw.
 */

/** Only the fields the popup reads. Kept narrow so a change to /v2/live shows up here as a type error. */
export type PopupFlight = {
  callsign: string | null
  iata_number: string | null
  airline_iata?: string | null
  dep_iata: string | null
  arr_iata: string | null
  phase: string
  eta_stable_utc?: string | null
  delay_min?: number | null
  position: {
    altitude_ft: number | null
    ground_speed_kts: number | null
    track_deg: number | null
    fix_at: string | null
    pos_source: string | null
  } | null
}

/**
 * A fix older than this is called out rather than shown as current.
 *
 * Two minutes, because an individual aircraft's fix arrives roughly every 55 seconds — measured
 * 26 Aug across 15 flights. Missing one is normal and says nothing; missing two in a row means
 * the aircraft has genuinely gone quiet.
 */
export const STALE_FIX_SEC = 120

const esc = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

/**
 * The words for a phase, in the reader's language.
 *
 * The web already carries a phase vocabulary in both languages — the board uses it — so V3 speaks
 * the server's own word rather than inventing a parallel set that could drift from it.
 */
export function phaseLabel(phase: string, locale = getActiveLocale()): string {
  const direct = translate(locale, `phase.${phase}`)
  if (direct !== `phase.${phase}`) return direct
  // en_route, departed, diverted and cancelled live under status.* — the board's vocabulary,
  // which predates the phase ladder and is what a reader already sees on the board.
  const asStatus = translate(locale, `status.${phase}`)
  if (asStatus !== `status.${phase}`) return asStatus
  return translate(locale, 'status.in_air')
}

/** The badge for a flight, in V2's colours so the two maps look the same. */
export function statusBadge(
  f: PopupFlight,
  nowMs: number,
  locale = getActiveLocale(),
): PopupStatus {
  const label = phaseLabel(f.phase, locale)

  // A worked-out position, not an observed one. The tilde is V2's mark for the same thing, kept
  // so a reader moving between the two maps does not have to learn a second convention.
  if (f.position?.pos_source === 'projected') return { label: `~ ${label}`, bg: '#713f12', fg: '#fbbf24' }

  const age = fixAgeSec(f, nowMs)
  if (age !== null && age > STALE_FIX_SEC) {
    return { label: `${label} · ${translate(locale, 'map.signal_lost')}`, bg: '#7f1d1d', fg: '#f87171' }
  }
  return { label, bg: '#166534', fg: '#4ade80' }
}

/**
 * How old the fix is, in seconds, or null if it cannot be known.
 *
 * NULL IS NOT ZERO. A fix with no timestamp is not a fresh fix — it is one whose age we cannot
 * measure, and treating that as current is how a stale marker gets drawn as live. The caller
 * shows nothing rather than guessing.
 */
export function fixAgeSec(f: PopupFlight, nowMs: number): number | null {
  const at = f.position?.fix_at
  if (!at) return null
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.round((nowMs - t) / 1000))
}

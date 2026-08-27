/**
 * Which map the reader is looking at, while the second one is being built.
 *
 * The website's map draws positions its own FlightPredictor works out when the signal drops. That
 * is what put an arrived flight over the Gulf on 27 Aug: it had landed at Sharjah, its fixes went
 * on_ground, /api/airspace dropped them, and the client filled the silence by projecting it along
 * the stored route — which runs over water. The marker sat there until the hold expired.
 *
 * V3 does not do that. It draws what /v2/live asserts and nothing else, and the server withholds
 * a position rather than guessing. The mobile app has been on it since 26 Aug.
 *
 * ── Why a toggle rather than a replacement ──
 *
 * components/Map.tsx is 3,360 lines and carries the most tested behaviour on the site: popups,
 * the schedule ghosts, Over Syria, the airport circles, the embed. Swapping it wholesale means
 * discovering what was lost from a bug report.
 *
 * With both mounted, the two are compared on real traffic by whoever is holding the phone, and
 * going back is a click rather than a rollback. That is exactly how the app's own v2/v3 rewrite
 * was de-risked, and it is the reason that one landed without a regression.
 *
 * The /map page only. /embed is the app's webview and has no room for a control the app cannot
 * see, so it stays on the map it has always had.
 *
 * TEMPORARY. This module and the toggle go when V3 is the only map.
 */

export const MAP_VARIANTS = ['v2', 'v3'] as const
export type MapVariant = (typeof MAP_VARIANTS)[number]

/**
 * The current map, until V3 has earned the default.
 *
 * A rewrite is not the default on the day it is written. V3 becomes it once it has been watched
 * against V2 on real arrivals — the case V2 gets wrong — and not before.
 */
export const DEFAULT_VARIANT: MapVariant = 'v2'

const KEY = 'flysyria:map-variant'

export function isVariant(v: unknown): v is MapVariant {
  return typeof v === 'string' && (MAP_VARIANTS as readonly string[]).includes(v)
}

/**
 * The reader's choice, or the default.
 *
 * Anything unrecognised falls back rather than throwing — a value stored by a build that offered
 * different names must not leave someone with a blank page, and that is not hypothetical: the
 * app's own store had to survive a stored 'v1' after v1 was removed.
 *
 * Storage throws in private mode, so the read is guarded too.
 */
export function storedVariant(): MapVariant {
  try {
    const v = localStorage.getItem(KEY)
    return isVariant(v) ? v : DEFAULT_VARIANT
  } catch {
    return DEFAULT_VARIANT
  }
}

export function storeVariant(v: MapVariant): void {
  try { localStorage.setItem(KEY, v) } catch { /* private mode: the choice lasts one visit */ }
}

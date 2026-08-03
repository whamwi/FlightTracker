/**
 * The ADS-B sweep, extracted so the cron and the request path share one definition.
 *
 * This used to live inside /api/airspace and run *from the request*, cached in a
 * module-level variable. That cache is per-lambda-instance, so under load each new instance
 * ran its own sweep of all five circles. adsb.fi's public limit is about one request per
 * second; a few dozen concurrent instances is enough to earn a 429 and then a block, which
 * takes the map dark for everyone at once. The cron now owns the sweep and writes to
 * Supabase, so upstream traffic is O(1) in users rather than O(users).
 *
 * `dist` is in NAUTICAL MILES, not km — verified against a dense-coverage area, where a
 * dist=250 query returned aircraft out to 233 nm (431 km). So the Syria circle spans
 * 1,296 km, not 700. Get this wrong and the circles look half the size they are.
 *
 * adsb.fi's v2 lat/lon/dist endpoint is DEPRECATED and answers 200 with an empty `ac`
 * array — not an error. Combined with the adsb.lol fallback also returning 200-and-empty
 * for this region, that read as "feeds healthy, quiet sky" for as long as it was wrong.
 * Measured 2026-08-02: v2 IST/250 → 0 aircraft, v3 IST/250 → 88, v3 DAM/250 → 31.
 *
 * v3 caps `dist` at 250 NM (400 returns HTTP 400).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const FEEDS_SYRIA: string[] = [
  'https://opendata.adsb.fi/api/v3/lat/33.41/lon/36.52/dist/250',
  'https://api.adsb.lol/v2/lat/33.41/lon/36.52/dist/250',
]
const FEEDS_UAE: string[] = [
  'https://opendata.adsb.fi/api/v3/lat/25.0/lon/55.0/dist/250',
  'https://api.adsb.lol/v2/lat/25.0/lon/55.0/dist/250',
]
// Istanbul — both IST–DAM corridors originate here, and it is the densest airspace the
// board touches (v3 returned 88 aircraft at 02:15 UTC).
const FEEDS_TURKEY: string[] = [
  'https://opendata.adsb.fi/api/v3/lat/41.0/lon/29.0/dist/250',
  'https://api.adsb.lol/v2/lat/41.0/lon/29.0/dist/250',
]
// Central Anatolia. At 250 NM the Damascus and Istanbul circles no longer meet, and the
// gap falls squarely across the middle of both IST–DAM corridors. This closes it.
const FEEDS_ANATOLIA: string[] = [
  'https://opendata.adsb.fi/api/v3/lat/38.0/lon/33.5/dist/250',
  'https://api.adsb.lol/v2/lat/38.0/lon/33.5/dist/250',
]
// Northern Arabia. Centred between Riyadh and Kuwait so one circle reaches both (133 nm
// each), plus Dammam and Basra — four airports otherwise invisible. It also fills most of
// the DAM–Gulf corridor, which was 54% uncovered.
const FEEDS_ARABIA: string[] = [
  'https://opendata.adsb.fi/api/v3/lat/27.1/lon/47.3/dist/250',
  'https://api.adsb.lol/v2/lat/27.1/lon/47.3/dist/250',
]

export const CIRCLES: string[][] = [FEEDS_SYRIA, FEEDS_UAE, FEEDS_TURKEY, FEEDS_ANATOLIA, FEEDS_ARABIA]

/**
 * A feed that answered with an empty list and a feed that never answered are different
 * facts, and every caller downstream needs to tell them apart: one means quiet airspace,
 * the other means we are blind. Returning [] for both is what kept the DB fallback from
 * ever firing — the map simply cleared.
 */
export interface FeedResult { ok: boolean; aircraft: any[] }

export async function fetchRadiusFeed(feeds: string[]): Promise<FeedResult> {
  for (const url of feeds) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'FlightTracker/1.0' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) continue
      const json = await res.json()
      return { ok: true, aircraft: (json.ac ?? []).filter((a: any) => a.lat != null && a.lon != null) }
    } catch { /* try next */ }
  }
  return { ok: false, aircraft: [] }
}

/**
 * One sweep of every circle, sequentially with a gap, because adsb.fi's public limit is
 * about 1 request/second and firing them together earns a 429 on most.
 *
 * One surviving circle still gives a real picture; only a clean sweep of failures means we
 * are blind, which is what `live` reports.
 */
export async function sweepAllCircles(): Promise<{ aircraft: any[]; live: boolean; circlesOk: number }> {
  const results: FeedResult[] = []
  for (let i = 0; i < CIRCLES.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1_100))
    results.push(await fetchRadiusFeed(CIRCLES[i]))
  }

  const circlesOk = results.filter(r => r.ok).length
  const seenHex = new Set<string>()
  const merged: any[] = []
  // Syria first: on an overlapping aircraft its entry wins, keeping the home circle's fix
  // rather than a neighbouring circle's copy.
  for (const a of results.flatMap(r => r.aircraft)) {
    if (!a?.hex || seenHex.has(a.hex)) continue
    seenHex.add(a.hex)
    merged.push(a)
  }
  return { aircraft: merged, live: circlesOk > 0, circlesOk }
}

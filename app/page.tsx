import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { userAgent } from 'next/server'
import { DEFAULT_LOCALE, isLocale } from '@/lib/i18n'

/**
 * The root is a router, not a page: phones get the board, everything else gets the map.
 *
 * The two devices want different things. On a desktop the map opens with the flight panel
 * populated, videos playing and room for all of it. On a phone the map is thin for most of
 * the day — between 21:00 and 06:00 Syria time only one to five flights are airborne against
 * thirteen to nineteen at midday — so a visitor at the wrong hour would land on an almost
 * empty screen, having paid for Leaflet, map tiles and the airspace feed to get there. The
 * board always has the full day on it and is a fraction of the weight.
 *
 * A redirect rather than a rewrite: it keeps /map and /board as distinct URLs, so analytics
 * can tell them apart and a shared link means the same thing wherever it is opened.
 *
 * Detection is server-side, so nothing is painted and thrown away. Tablets fall through to
 * the map deliberately — they have the room.
 */

export const dynamic = 'force-dynamic'

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // Links shared before the map moved point at /?flight=XX123, and they should still open
  // the map on any device — someone tapping a flight link wants that flight, not a schedule.
  const sp = await searchParams
  const h  = await headers()

  /*
   * Carry the language through the redirect.
   *
   * This route is the one place a locale can be silently lost: it sends every visitor
   * somewhere else, and with a hardcoded path /ar landed on the English map. Anyone opening
   * the bare Arabic link — which is the one worth sharing — arrived in English.
   */
  const raw    = h.get('x-flysyria-locale')
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE
  const at     = (path: string) => (locale === DEFAULT_LOCALE ? path : `/${locale}${path}`)

  // Links shared before the map moved point at /?flight=XX123, and they should still open
  // the map on any device — someone tapping a flight link wants that flight, not a schedule.
  const flight = typeof sp?.flight === 'string' ? sp.flight : null
  if (flight) redirect(at(`/map?flight=${encodeURIComponent(flight)}`))

  const { device } = userAgent({ headers: h })
  redirect(at(device.type === 'mobile' ? '/board' : '/map'))
}

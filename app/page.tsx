import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { userAgent } from 'next/server'

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
  const flight = typeof sp?.flight === 'string' ? sp.flight : null
  if (flight) redirect(`/map?flight=${encodeURIComponent(flight)}`)

  const { device } = userAgent({ headers: await headers() })
  redirect(device.type === 'mobile' ? '/board' : '/map')
}

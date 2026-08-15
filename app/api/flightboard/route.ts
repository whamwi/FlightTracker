import { NextResponse } from 'next/server'
import { boardFromV2 } from '@/lib/board-v2'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  if (!date) return NextResponse.json({ ok: false, error: 'date required' }, { status: 400 })

  const v2 = await boardFromV2(date, 'flightboard')
  if (v2) {
    return NextResponse.json(
      { ok: true, date, flights: v2, source: 'v2' },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } },
    )
  }

  /*
   * No cache fallback.
   *
   * Everything from here to the end of the handler used to be a second, independent board
   * builder: five reads of fr24_daily_cache — the Syrian airports, the origin airports for
   * inbound legs, the next day for arrivals after midnight, the previous day for departures
   * before it, and the destination boards — merged, ranked and de-duplicated into the same
   * shape boardFromV2 returns above. Some four hundred lines maintaining a parallel answer to
   * the same question.
   *
   * That is what made this table dangerous rather than merely redundant. Two builders reading
   * different sources will disagree, and the disagreement surfaces as a flight that is airborne
   * on one screen and landed on another — which is what XH728 did on 12 Aug, when its cache row
   * carried the previous day's arrival times.
   *
   * The cache is written only by whoever opens /fr24 in a browser. Serving from it means
   * publishing one visitor's snapshot as the board, with nothing in the response to say so.
   * A 502 says the board is unreachable, which is true and recoverable; a stale board is
   * neither.
   */
  return NextResponse.json(
    { ok: false, date, error: 'board unavailable' },
    { status: 502 },
  )
}
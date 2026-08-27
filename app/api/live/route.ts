import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * The live layer: where each airborne flight is in its journey.
 *
 * A separate endpoint from /api/flightboard rather than a field on it. The board is per-date and
 * cacheable — a flight's schedule, terminal and gate do not change between two readers a minute
 * apart — while phase changes constantly and applies to a handful of rows. Folding one into the
 * other would make the whole board uncacheable to carry a field most of it does not have.
 *
 * It is a proxy rather than a direct call from the page because the browser would otherwise have
 * to reach Railway across origins, and because this keeps the upstream host in one place: the web
 * already talks to /v2/board through lib/board-v2, and this is the same arrangement for /v2/live.
 *
 * No cache fallback, deliberately. There is nothing to fall back to — the phase either comes from
 * a current fix or it does not exist, and the caller renders the status badge it already has.
 */
const V2_API = process.env.FLIGHT_API_URL ?? 'https://flight-api-production-5124.up.railway.app'

/*
 * ?paths=1 asks for the corridors as well.
 *
 * OPT-IN, because the two callers want different things. The board reads this for phase alone and
 * would carry roughly 20 KB of waypoints on every poll for nothing. The map needs them to animate
 * and can hold them for as long as it likes — corridors change when the learner runs, not between
 * polls. Same reasoning as /v2/live's own flag, which this forwards to.
 */
export async function GET(req: Request) {
  const wantPaths = new URL(req.url).searchParams.get('paths') === '1'
  try {
    const r = await fetch(`${V2_API}/v2/live${wantPaths ? '?paths=1' : ''}`, { cache: 'no-store' })
    if (!r.ok) {
      console.warn(`[live] v2 answered ${r.status}`)
      return NextResponse.json({ ok: false, flights: [] }, { status: 200 })
    }
    const body = await r.json()
    return NextResponse.json({
      ok: true,
      // The instant the server built it. The map animates from THIS, not from when it fetched —
      // the document is cached briefly, so fetch time resets a clock the fractions did not.
      as_of: body?.as_of ?? null,
      flights: body?.flights ?? [],
      // Absent unless asked for, so the board's response does not grow.
      ...(wantPaths ? { paths: body?.paths ?? {} } : {}),
    })
  } catch (e) {
    // 200 with an empty list, not a 5xx: an absent phase is a normal state the card already
    // handles, and a failing request here must not colour the board's own error handling.
    console.warn(`[live] v2 unreachable: ${e}`)
    return NextResponse.json({ ok: false, flights: [] }, { status: 200 })
  }
}

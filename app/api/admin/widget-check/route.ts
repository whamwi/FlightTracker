import { NextResponse } from 'next/server'

/**
 * Can this server reach FR24's airport widget, or does Cloudflare stop it?
 *
 * The 23-airport harvest runs in the browser today, so it only refreshes while somebody has
 * the board open. Moving it to a cron depends entirely on this answer.
 *
 * Tried both bare and with browser headers, because from a residential connection the bare
 * request was challenged and the browser-header one served — which looked like the filter was
 * header-based. Running both from here is what shows whether that was the real reason or a
 * coincidence of that connection being trusted.
 *
 * Under /api/admin so the existing Basic auth session covers it.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/126 Safari/537.36'

export async function GET(req: Request) {
  const ap = new URL(req.url).searchParams.get('ap') ?? 'KWI'
  const ts = Math.floor(Date.now() / 1000)
  const url = `https://api.flightradar24.com/common/v1/airport.json?code=${ap}&plugin=`
            + `&plugin-setting[schedule][mode]=&plugin-setting[schedule][timestamp]=${ts}`
            + `&page=1&limit=100&fleet=&token=`

  const attempt = async (label: string, headers: Record<string, string>) => {
    const t0 = Date.now()
    try {
      const res  = await fetch(url, { headers, cache: 'no-store' })
      const body = await res.text()
      let arrivals: number | null = null
      let departures: number | null = null
      try {
        const s = JSON.parse(body).result.response.airport.pluginData.schedule
        arrivals   = (s.arrivals   ?? {}).data?.length ?? null
        departures = (s.departures ?? {}).data?.length ?? null
      } catch { /* not JSON — almost certainly the Cloudflare interstitial */ }
      return {
        label, status: res.status, ms: Date.now() - t0, bytes: body.length,
        arrivals, departures,
        blockedByCloudflare: /Just a moment|cf-browser-verification|challenge-platform/i.test(body.slice(0, 2000)),
        head: body.slice(0, 120),
      }
    } catch (e) {
      return { label, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 }
    }
  }

  const results = [
    await attempt('bare', {}),
    await attempt('browser-headers', {
      'User-Agent': UA,
      Accept: 'application/json',
      Referer: 'https://www.flightradar24.com/',
      'Accept-Language': 'en-US,en;q=0.9',
    }),
  ]

  return NextResponse.json({
    ok: true,
    airport: ap,
    // Stated plainly so the result does not need interpreting.
    verdict: results.every(r => 'blockedByCloudflare' in r && r.blockedByCloudflare)
      ? 'BLOCKED — this server cannot harvest the widget; a residential host is needed'
      : results.some(r => 'arrivals' in r && r.arrivals !== null)
        ? 'REACHABLE — the harvest could move server-side'
        : 'INCONCLUSIVE — neither blocked nor parsed; read the raw fields',
    results,
  })
}

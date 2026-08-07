import { NextResponse } from 'next/server'

/**
 * Can a Vercel function reach FR24's airport widget, or does Cloudflare stop it?
 *
 * The whole 23-airport harvest currently runs in the browser, which means it only refreshes
 * while somebody has the board open. Moving it server-side removes that, but only if this
 * endpoint answers to a datacenter IP.
 *
 * From a residential connection the same IP was challenged without browser headers and served
 * with them — so the filter looked header-based rather than address-based. This is the test of
 * whether that holds from here.
 *
 * Diagnostic only. Delete once the answer is known.
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
      const res = await fetch(url, { headers, cache: 'no-store' })
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
        looksLikeChallenge: /Just a moment|cf-browser-verification|challenge-platform/i.test(body.slice(0, 2000)),
        head: body.slice(0, 120),
      }
    } catch (e) {
      return { label, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 }
    }
  }

  return NextResponse.json({
    ok: true,
    airport: ap,
    // Both, so the result says whether headers are the deciding factor here as they were
    // from a residential connection.
    results: [
      await attempt('bare', {}),
      await attempt('browser-headers', {
        'User-Agent': UA,
        Accept: 'application/json',
        Referer: 'https://www.flightradar24.com/',
        'Accept-Language': 'en-US,en;q=0.9',
      }),
    ],
  })
}

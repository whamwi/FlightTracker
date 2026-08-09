import { NextResponse } from 'next/server'

/**
 * Can the widget endpoint be reached from a server, or only from a browser?
 *
 * The whole schedule cache is written by whoever has the board open — the board fetches
 * FR24's public widget JSON client-side and POSTs it to /api/fr24-cache. Nothing on a
 * schedule does it, so an evening with no visitor leaves a hole in the data, which is what
 * happened overnight on 8 Aug: the last DAM write was 00:45 and the next was 04:30, when a
 * browser opened.
 *
 * Moving that to a cron is only possible if Cloudflare lets a datacenter IP through. That was
 * assumed to be a no and never written down, so this measures it instead of repeating it.
 * Reports the status and a slice of the body — a challenge page and real JSON are obvious
 * apart — for a Syrian airport and, as a control, one with heavy traffic.
 */

export const dynamic = 'force-dynamic'

const TZ = 'Asia/Damascus'

async function probe(code: string) {
  const flightDate = new Date().toLocaleDateString('en-CA', { timeZone: TZ })
  const ts  = Math.floor(new Date(flightDate + 'T00:00:00+03:00').getTime() / 1000)
  const url = `https://api.flightradar24.com/common/v1/airport.json?code=${code}`
            + `&plugin=&plugin-setting[schedule][mode]=&plugin-setting[schedule][timestamp]=${ts}`
            + `&page=1&limit=100&fleet=&token=`

  const started = Date.now()
  try {
    const res  = await fetch(url, { cache: 'no-store' })
    const body = await res.text()
    let counts: { arrivals?: number; departures?: number } | null = null
    try {
      const sched = JSON.parse(body)?.result?.response?.airport?.pluginData?.schedule
      if (sched) counts = { arrivals: sched.arrivals?.data?.length ?? 0, departures: sched.departures?.data?.length ?? 0 }
    } catch { /* not JSON — almost certainly a challenge page */ }
    return {
      code, status: res.status, ms: Date.now() - started,
      contentType: res.headers.get('content-type'),
      cfRay: res.headers.get('cf-ray'),
      bytes: body.length,
      counts,
      head: counts ? null : body.slice(0, 300),
    }
  } catch (err) {
    return { code, error: String(err), ms: Date.now() - started }
  }
}

export async function GET() {
  const results = await Promise.all(['DAM', 'IST'].map(probe))
  return NextResponse.json({ ok: true, from: 'vercel-server', results })
}

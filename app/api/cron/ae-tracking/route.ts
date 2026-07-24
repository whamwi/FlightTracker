import { NextResponse } from 'next/server'

export const dynamic   = 'force-dynamic'
export const maxDuration = 30

const AE_KEY  = process.env.AVIATION_EDGE_KEY!
const AE_BASE = 'https://aviation-edge.com/v2/public/flights'
const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_ANON_KEY!

const QUERIES = [
  { airport: 'DAM', direction: 'dep', param: 'depIata', value: 'DAM' },
  { airport: 'DAM', direction: 'arr', param: 'arrIata', value: 'DAM' },
  { airport: 'ALP', direction: 'dep', param: 'depIata', value: 'ALP' },
  { airport: 'ALP', direction: 'arr', param: 'arrIata', value: 'ALP' },
]

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  if (!AE_KEY) {
    return NextResponse.json({ ok: false, error: 'AVIATION_EDGE_KEY not set' }, { status: 503 })
  }

  const ran_at = new Date().toISOString()
  const rows: object[] = []
  const summary: string[] = []

  for (const q of QUERIES) {
    try {
      const url = `${AE_BASE}?key=${AE_KEY}&${q.param}=${q.value}`
      const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })

      if (!res.ok) {
        summary.push(`${q.direction}/${q.airport}: HTTP ${res.status}`)
        await sleep(1500)
        continue
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any[] = await res.json()
      const flights = Array.isArray(data) ? data : []

      rows.push({
        ran_at,
        airport:      q.airport,
        direction:    q.direction,
        flight_count: flights.length,
        payload:      flights,
      })

      summary.push(`${q.direction}/${q.airport}: ${flights.length} flights`)
    } catch (e) {
      summary.push(`${q.direction}/${q.airport}: error — ${String(e)}`)
    }

    await sleep(1500)
  }

  // Write all 4 rows in one request
  if (rows.length > 0) {
    await fetch(`${SB_URL}/rest/v1/ae_tracking_log`, {
      method:  'POST',
      headers: {
        apikey:         SB_KEY,
        Authorization:  `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body: JSON.stringify(rows),
    }).catch(e => console.error('[ae-tracking] DB write failed:', e))
  }

  return NextResponse.json({ ok: true, ran_at, summary, rows_written: rows.length })
}

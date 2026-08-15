import { NextResponse } from 'next/server'
import { logSignals, type SignalReading } from '@/lib/signal-log'

export const dynamic = 'force-dynamic'

/**
 * Accepts position readings and records them. The logic lives in lib/signal-log so the airspace
 * cron can write the same rows without a self-request.
 *
 * The web map stopped calling this on 15 Aug — server-side polling now supplies these rows for
 * everyone, rather than only while somebody has the map open. The endpoint stays because the
 * mobile app shares these routes, and because a reading offered from a real device is still worth
 * recording.
 */
export async function POST(req: Request) {
  let batch: SignalReading[]
  try { batch = await req.json() } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 })
  }
  if (!Array.isArray(batch) || batch.length === 0)
    return NextResponse.json({ ok: false, error: 'empty batch' }, { status: 400 })

  const processed = await logSignals(batch, new Date().toISOString())
  return NextResponse.json({ ok: true, processed })
}

import { NextResponse } from 'next/server'

/**
 * Retention for route_path_samples.
 *
 * Roughly 20 flights sampled once a minute for a few hours each is on the order of 20k rows
 * a day. Kept long enough that seasonal corridor changes are visible and that a route flown
 * twice a week still accumulates enough legs to be believed, then dropped.
 *
 * Deletes by age rather than truncating: aggregation is expected to run over a trailing
 * window, and a blanket wipe would take out the evidence for a proposal mid-way through
 * gathering it.
 */

export const dynamic = 'force-dynamic'

const SB_URL     = process.env.SUPABASE_URL!
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const RETENTION_DAYS = 90

export async function GET() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString()
  const res = await fetch(`${SB_URL}/rest/v1/route_path_samples?created_at=lt.${cutoff}`, {
    method:  'DELETE',
    headers: { ...SB_HEADERS, Prefer: 'return=representation' },
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200)
    console.error('[prune-path-samples] failed', res.status, body)
    return NextResponse.json({ ok: false, status: res.status, body }, { status: 502 })
  }
  const deleted = ((await res.json()) as unknown[]).length
  return NextResponse.json({ ok: true, deleted, cutoff })
}

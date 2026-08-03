import { NextResponse } from 'next/server'

/**
 * Retention for the two tables the airspace poller writes.
 *
 * `aircraft_last_seen` is upserted by hex, so it is bounded by distinct airframes rather
 * than time — it reached only ~10k rows in 15 days. The cost that matters is not row count
 * but UPDATE churn: 21.5 million updates against 10k rows, every one firing the
 * manage_flight_tracking trigger and leaving a dead tuple for autovacuum. Pruning does not
 * touch that; it just stops airframes seen once, months ago, from being carried forever
 * along with their raw payloads.
 *
 * Deletes by age rather than truncating. A blanket wipe would also take out aircraft that
 * are airborne at that moment, dropping the fallback out from under a flight in progress and
 * resetting the first_seen/approach state the trigger exists to preserve. Anything not seen
 * for three days is, by definition, not one of those.
 *
 * airspace_poll_log grows ~1,440 rows/day and nothing reads beyond the recent window, so it
 * keeps a month — enough to see a pattern, not enough to matter.
 */

export const dynamic = 'force-dynamic'

const SB_URL     = process.env.SUPABASE_URL!
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const POSITION_RETENTION_DAYS = 3
const LOG_RETENTION_DAYS      = 30

async function pruneOlderThan(table: string, column: string, days: number) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${column}=lt.${cutoff}`, {
    method:  'DELETE',
    headers: { ...SB_HEADERS, Prefer: 'return=representation' },
  })
  if (!res.ok) {
    console.error(`[prune-positions] ${table} failed`, res.status, (await res.text()).slice(0, 200))
    return { table, deleted: 0, ok: false }
  }
  const deleted = ((await res.json()) as unknown[]).length
  return { table, deleted, ok: true }
}

export async function GET() {
  const results = [
    await pruneOlderThan('aircraft_last_seen', 'seen_at', POSITION_RETENTION_DAYS),
    await pruneOlderThan('airspace_poll_log',  'ran_at', LOG_RETENTION_DAYS),
  ]
  return NextResponse.json({ ok: results.every(r => r.ok), results })
}

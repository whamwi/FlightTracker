import { NextResponse } from 'next/server'
import { isFresh, resolveUpstream, writeRow, type PhotoRow } from '@/lib/aircraft-photo'

/**
 * Resolves photos for aircraft that are airborne now, before anyone opens them.
 *
 * The cache alone still leaves the FIRST person to tap an aircraft waiting about three
 * seconds. We already know which registrations are in the air every minute, so the lookup
 * can be done while nobody is waiting for it — which is the difference between a photo
 * appearing instantly and appearing after the sheet has already opened blank.
 *
 * Deliberately bounded. Only aircraft currently flying our routes, only ones not already
 * cached, and only a few per run: this is somebody else's API being called on behalf of
 * users who have not asked for anything yet, and after the first week it settles down to
 * the handful of new airframes that appear each day.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const SB_URL     = process.env.SUPABASE_URL!
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const SELF = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.flysyria.app'
/** Per run. Keeps a burst of new aircraft from turning into a burst of upstream calls. */
const MAX_PER_RUN = 5

export async function GET() {
  const started = Date.now()

  // Registrations currently airborne on our routes.
  const res = await fetch(`${SELF}/api/airspace`, { cache: 'no-store' })
  const ctype = res.headers.get('content-type') ?? ''
  if (!res.ok || !ctype.includes('application/json')) {
    return NextResponse.json({ ok: false, step: 'airspace', status: res.status }, { status: 502 })
  }
  const json = await res.json()

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const regs = [...new Set(
    (json.aircraft ?? [])
      .filter((a: any) => a?.board_match && typeof a?.r === 'string' && a.r.trim())
      .map((a: any) => a.r.trim().toUpperCase()),
  )] as string[]
  /* eslint-enable @typescript-eslint/no-explicit-any */

  if (!regs.length) {
    return NextResponse.json({ ok: true, airborne: 0, resolved: 0, ms: Date.now() - started })
  }

  // Which of those are already known and still fresh.
  const list = regs.map(r => `"${r}"`).join(',')
  const cachedRes = await fetch(
    `${SB_URL}/rest/v1/aircraft_photos?registration=in.(${encodeURIComponent(list)})&select=*`,
    { headers: SB_HEADERS },
  )
  const cached: PhotoRow[] = cachedRes.ok ? await cachedRes.json() : []
  const fresh = new Set(cached.filter(r => isFresh(r, Date.now())).map(r => r.registration))

  const todo = regs.filter(r => !fresh.has(r)).slice(0, MAX_PER_RUN)

  // Sequentially, not in parallel: a burst of concurrent requests to a free API is how a
  // polite integration becomes a blocked one.
  const done: { reg: string; found: boolean }[] = []
  for (const reg of todo) {
    const resolved = await resolveUpstream(reg)
    await writeRow(reg, resolved)
    done.push({ reg, found: !!resolved.url })
  }

  return NextResponse.json({
    ok: true,
    airborne: regs.length,
    alreadyCached: fresh.size,
    resolved: done.length,
    found: done.filter(d => d.found).length,
    detail: done,
    ms: Date.now() - started,
  })
}

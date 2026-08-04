import { NextResponse } from 'next/server'
import { photoForReg, rememberRegistration, recallRegistration } from '@/lib/aircraft-photo'

/**
 * Photo for a callsign, via whichever registration we can find for it.
 *
 * The fallback for flights with no live ADS-B of their own. Two sources, in order:
 * what is broadcasting now, then what we remember. aircraft_last_seen is pruned after three
 * days and only holds aircraft that were actually heard, so on its own it loses flights that
 * are scheduled but silent — the common case over Syria.
 */
export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

async function regFromLastSeen(callsign: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/aircraft_last_seen?callsign=eq.${encodeURIComponent(callsign)}&order=seen_at.desc&limit=1&select=registration`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, signal: AbortSignal.timeout(5000) },
    )
    if (!res.ok) return null
    const rows = await res.json()
    return rows?.[0]?.registration ?? null
  } catch { return null }
}

export async function GET(req: Request, { params }: { params: Promise<{ callsign: string }> }) {
  const { callsign } = await params
  const origin = new URL(req.url).origin

  const heard = await regFromLastSeen(callsign)
  if (heard) {
    // Learned from a live contact — worth keeping for when it goes quiet.
    await rememberRegistration(callsign, heard, 'adsb')
    return NextResponse.json({ url: await photoForReg(heard, origin) })
  }

  const remembered = await recallRegistration(callsign)
  if (remembered) return NextResponse.json({ url: await photoForReg(remembered, origin) })

  return NextResponse.json({ url: null })
}

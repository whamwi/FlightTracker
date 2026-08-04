import { NextResponse } from 'next/server'
import { photoForReg } from '@/lib/aircraft-photo'

/**
 * Photo for a callsign, via the registration last seen broadcasting it.
 *
 * The fallback for flights with no live ADS-B, which carry no registration of their own.
 */
export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

export async function GET(req: Request, { params }: { params: Promise<{ callsign: string }> }) {
  const { callsign } = await params
  const origin = new URL(req.url).origin

  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/aircraft_last_seen?callsign=eq.${encodeURIComponent(callsign)}&order=seen_at.desc&limit=1&select=registration`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, signal: AbortSignal.timeout(5000) },
    )
    if (res.ok) {
      const rows = await res.json()
      const reg: string | null = rows?.[0]?.registration ?? null
      if (reg) return NextResponse.json({ url: await photoForReg(reg, origin) })
    }
  } catch { /* no registration, no photo */ }

  return NextResponse.json({ url: null })
}

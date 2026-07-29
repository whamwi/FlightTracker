import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const UA     = 'FlightTrackerSY/1.0 (+https://flighttracker-sy.vercel.app)'

async function photoForReg(reg: string, origin: string): Promise<string | null> {
  // Primary: jetapi.dev (JetPhotos full-res, proxied)
  try {
    const res = await fetch(
      `https://www.jetapi.dev/api?reg=${encodeURIComponent(reg)}&photos=1&only_jp=true`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const cdnUrl: string | null = data?.Images?.[0]?.Image ?? null
      if (cdnUrl) return `${origin}/api/photo-img?u=${encodeURIComponent(cdnUrl)}`
    }
  } catch {}

  // Fallback: Planespotters thumbnail_large
  try {
    const res = await fetch(
      `https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(reg)}`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      return data?.photos?.[0]?.thumbnail_large?.src ?? data?.photos?.[0]?.thumbnail?.src ?? null
    }
  } catch {}

  return null
}

export async function GET(req: Request, { params }: { params: Promise<{ callsign: string }> }) {
  const { callsign } = await params
  const origin = new URL(req.url).origin

  // Look up latest known registration from aircraft_last_seen
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/aircraft_last_seen?callsign=eq.${encodeURIComponent(callsign)}&order=seen_at.desc&limit=1&select=registration`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const rows = await res.json()
      const reg: string | null = rows?.[0]?.registration ?? null
      if (reg) {
        const url = await photoForReg(reg, origin)
        return NextResponse.json({ url })
      }
    }
  } catch {}

  return NextResponse.json({ url: null })
}

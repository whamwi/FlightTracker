import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const UA = 'FlightTrackerSY/1.0 (+https://flighttracker-sy.vercel.app)'

export async function GET(_req: Request, { params }: { params: { reg: string } }) {
  const { reg } = params

  // Primary: jetapi.dev — full-res JetPhotos CDN
  try {
    const res = await fetch(
      `https://www.jetapi.dev/api?reg=${encodeURIComponent(reg)}&photos=1&only_jp=true`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const url: string | null = data?.Images?.[0]?.Image ?? null
      if (url) return NextResponse.json({ url })
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
      const url: string | null =
        data?.photos?.[0]?.thumbnail_large?.src ?? data?.photos?.[0]?.thumbnail?.src ?? null
      if (url) return NextResponse.json({ url })
    }
  } catch {}

  return NextResponse.json({ url: null })
}

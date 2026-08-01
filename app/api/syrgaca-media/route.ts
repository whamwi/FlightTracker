import { NextResponse } from 'next/server'

/**
 * Read endpoint for the SyrGACA media gallery. Kept separate from the page so the
 * Expo app can consume the same feed.
 */

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!

const MAX_LIMIT = 100

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const limit  = Math.min(Number(searchParams.get('limit') ?? 40) || 40, MAX_LIMIT)
  const offset = Math.max(Number(searchParams.get('offset') ?? 0) || 0, 0)
  const type   = searchParams.get('type')

  const filter = type === 'photo' || type === 'video' ? `&media_type=eq.${type}` : ''

  const res = await fetch(
    `${SB_URL}/rest/v1/syrgaca_media` +
    `?select=media_id,source,media_type,video_id,caption,permalink,posted_at,image_url,thumb_url,width,height,pinned` +
    filter +
    // Pinned items sit above the feed; everything else is newest-first. nullslast keeps
    // a dateless row at the bottom rather than letting it jump to the top.
    `&order=pinned.desc,posted_at.desc.nullslast` +
    `&limit=${limit}&offset=${offset}`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, cache: 'no-store' },
  )
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `fetch failed: ${res.status}`, media: [] }, { status: 502 })
  }

  const media = await res.json()
  return NextResponse.json({ ok: true, media }, {
    headers: { 'Cache-Control': 's-maxage=300, stale-while-revalidate=600' },
  })
}

import { NextResponse } from 'next/server'

/**
 * Hand-picked videos for the aviation library — airline uploads and anything else worth
 * carrying that the SyGACA channel never posts.
 *
 * They share `syrgaca_media` with the channel sync so the gallery and the Track map's
 * rotation pick them up with no changes, but they are stored as source='curated'. That
 * matters: `cron/youtube-sync` DELETEs every source='youtube' row absent from its latest
 * channel batch, and a video from a different channel is absent by definition, so storing
 * these as 'youtube' would have them silently deleted within the day.
 *
 * Metadata comes from oEmbed for the title and the watch page's JSON-LD for the publish
 * date. Neither needs a key or quota. The date is not decoration: the gallery orders by
 * posted_at with nulls last, so dateless rows pile up behind every photo and channel video
 * and are effectively invisible. YOUTUBE_API_KEY would give the same date, but it is only
 * set in production, and a list that behaves differently by environment is worse.
 */

export const dynamic = 'force-dynamic'

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const SELECT = 'media_id,video_id,caption,permalink,thumb_url,posted_at,created_at,pinned'

/**
 * Accepts whatever the user actually copies: watch links, youtu.be, /embed/, /shorts/,
 * a link with a playlist or timestamp attached, or a bare 11-character id.
 */
function parseVideoId(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^[\w-]{11}$/.test(raw)) return raw

  let u: URL
  try {
    u = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (!/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(u.hostname)) return null

  const v = u.searchParams.get('v')
  if (v && /^[\w-]{11}$/.test(v)) return v

  // youtu.be/<id>, /embed/<id>, /shorts/<id>, /live/<id> all put the id in the last segment.
  const last = u.pathname.split('/').filter(Boolean).pop() ?? ''
  return /^[\w-]{11}$/.test(last) ? last : null
}

async function fetchTitle(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      { cache: 'no-store' },
    )
    if (!res.ok) return null
    const j = await res.json()
    // author_name is the channel — worth keeping, since the point of a curated entry is
    // usually which airline posted it.
    return [j.title, j.author_name].filter(Boolean).join(' — ') || null
  } catch {
    return null
  }
}

// The watch page carries JSON-LD with the real upload date. Scraping is not ideal, but the
// alternative is either an API key or no date at all, and no date means the entry sinks
// below every dated row in the gallery.
async function fetchUploadDate(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'Accept-Language': 'en' },
      cache:   'no-store',
    })
    if (!res.ok) return null
    const m = /"uploadDate":"([^"]+)"/.exec(await res.text())
    if (!m) return null
    const d = new Date(m[1])
    return isNaN(d.getTime()) ? null : d.toISOString()
  } catch {
    return null
  }
}

export async function GET() {
  const res = await fetch(
    `${SB_URL}/rest/v1/syrgaca_media?select=${SELECT}&source=eq.curated&order=created_at.desc`,
    { headers: HEADERS, cache: 'no-store' },
  )
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `fetch failed: ${res.status}`, videos: [] }, { status: 502 })
  }
  return NextResponse.json({ ok: true, videos: await res.json() })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const url  = typeof body?.url === 'string' ? body.url : ''
  const videoId = parseVideoId(url)
  if (!videoId) {
    return NextResponse.json({ ok: false, error: 'Not a YouTube link — paste a watch, youtu.be, embed or shorts URL.' }, { status: 400 })
  }

  const manual = typeof body?.caption === 'string' ? body.caption.trim() : ''
  const [fetched, postedAt] = await Promise.all([
    manual ? Promise.resolve(null) : fetchTitle(videoId),
    fetchUploadDate(videoId),
  ])
  const caption = manual || fetched

  const row = {
    media_id:   `curated:${videoId}`,
    post_id:    null,
    source:     'curated',
    media_type: 'video',
    video_id:   videoId,
    caption,
    permalink:  `https://www.youtube.com/watch?v=${videoId}`,
    posted_at:  postedAt,
    image_url:  null,
    thumb_url:  `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    width:      480,
    height:     360,
  }

  // merge-duplicates so re-adding a link updates its caption rather than 409ing. The id is
  // derived from the video, so the same video cannot be added twice under two rows.
  const res = await fetch(`${SB_URL}/rest/v1/syrgaca_media?on_conflict=media_id`, {
    method:  'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
    body:    JSON.stringify([row]),
  })
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `insert failed: ${res.status} ${await res.text()}` }, { status: 502 })
  }

  // A channel-synced copy of the same video would collide in the rotation. Report it so the
  // admin page can say the video is already in the library rather than showing a duplicate.
  const dupRes = await fetch(
    `${SB_URL}/rest/v1/syrgaca_media?select=media_id&video_id=eq.${videoId}&source=neq.curated`,
    { headers: HEADERS, cache: 'no-store' },
  )
  const dup = dupRes.ok ? ((await dupRes.json()) as unknown[]).length > 0 : false

  const [saved] = await res.json()
  return NextResponse.json({ ok: true, video: saved, alreadyFromChannel: dup })
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('media_id') ?? ''
  // Scoped to source=curated so this endpoint can never delete a channel-synced row.
  if (!id.startsWith('curated:')) {
    return NextResponse.json({ ok: false, error: 'media_id must be a curated entry' }, { status: 400 })
  }

  const res = await fetch(
    `${SB_URL}/rest/v1/syrgaca_media?media_id=eq.${encodeURIComponent(id)}&source=eq.curated`,
    { method: 'DELETE', headers: { ...HEADERS, Prefer: 'return=representation' } },
  )
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `delete failed: ${res.status}` }, { status: 502 })
  }
  const removed = ((await res.json()) as unknown[]).length
  if (!removed) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true, removed })
}

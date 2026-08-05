import { NextResponse } from 'next/server'

/**
 * Pulls videos from the Syrian Civil Aviation Authority YouTube channel
 * (@SyGACA — note the Facebook handle is @SyrGACA, with an extra "r") into
 * `syrgaca_media` as source='youtube'.
 *
 * Requires YOUTUBE_API_KEY. Every channel's uploads live in a playlist whose id is the
 * channel id with "UC" swapped for "UU", so the full backlog is readable with plain
 * `playlistItems.list` calls at 1 quota unit each against 10,000 a day — one run costs
 * single digits.
 *
 * There was a keyless RSS fallback. It is gone because it no longer works: YouTube now
 * answers 404 for this channel's feed in every form — channel_id, playlist_id and user,
 * with and without a browser User-Agent. Since it only ran when the key was ABSENT, it
 * would have failed at precisely the moment it was meant to help, and silently: the
 * gallery keeps serving the videos already stored, so nothing looks wrong. A fallback
 * that cannot work is worse than none, because it stops anyone looking for a real one.
 *
 * Shorts are excluded. The feed does not flag them, but YouTube's own routing does: a
 * request to /shorts/<id> stays there for a real Short and 303s to /watch?v= for a
 * normal upload. That is one cheap HEAD per video — unlike a duration cutoff, which
 * would still misfile genuinely short normal uploads.
 *
 * Nothing is rehosted either way: i.ytimg.com thumbnails are stable and permanent, and
 * playback is an embedded player rather than a stored file.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 120

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const YT_KEY     = process.env.YOUTUBE_API_KEY
const CHANNEL_ID = 'UCs6IVL4TzZC86uVLouwPHzQ'
const UPLOADS    = `UU${CHANNEL_ID.slice(2)}`

// How many full-length videos to keep.
const TARGET = 30
// Safety bound on playlist pages, not a target.
const MAX_PAGES = 10
// Concurrency for the Shorts probe — enough to stay well inside maxDuration.
const PROBE_BATCH = 8

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRec = Record<string, any>

type VideoRow = {
  media_id:   string
  post_id:    null
  source:     'youtube'
  media_type: 'video'
  video_id:   string
  caption:    string | null
  permalink:  string
  posted_at:  string | null
  image_url:  null
  thumb_url:  string
  width:      number | null
  height:     number | null
}

// hqdefault is the one derivative YouTube generates for every video, including old
// and low-resolution uploads — maxres is frequently absent.
const thumbFor = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`

function row(videoId: string, title: string, publishedAt: string | null, thumb?: string, w?: number | null, h?: number | null): VideoRow {
  return {
    media_id:   `yt:${videoId}`,
    post_id:    null,
    source:     'youtube',
    media_type: 'video',
    video_id:   videoId,
    caption:    title.trim() || null,
    permalink:  `https://www.youtube.com/watch?v=${videoId}`,
    posted_at:  publishedAt,
    image_url:  null,
    thumb_url:  thumb ?? thumbFor(videoId),
    width:      w ?? 480,
    height:     h ?? 360,
  }
}

// ── Shorts filter ─────────────────────────────────────────────────────────────
async function isShort(videoId: string): Promise<boolean> {
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: 'HEAD', redirect: 'manual', cache: 'no-store',
    })
    return res.status === 200
  } catch {
    // On a probe failure keep the video: a missed Short is a smaller problem than
    // silently dropping a real upload.
    return false
  }
}

async function dropShorts(rows: VideoRow[]): Promise<{ kept: VideoRow[]; dropped: number }> {
  const kept: VideoRow[] = []
  let dropped = 0

  for (let i = 0; i < rows.length; i += PROBE_BATCH) {
    const chunk = rows.slice(i, i + PROBE_BATCH)
    const flags = await Promise.all(chunk.map((r) => isShort(r.video_id)))
    chunk.forEach((r, j) => { if (flags[j]) dropped++; else kept.push(r) })
  }

  return { kept, dropped }
}

// ── Data API path ─────────────────────────────────────────────────────────────
function bestThumb(thumbs: AnyRec = {}) {
  const t = thumbs.maxres ?? thumbs.standard ?? thumbs.high ?? thumbs.medium ?? thumbs.default
  return t ? { url: t.url as string, width: t.width ?? null, height: t.height ?? null } : null
}

async function fetchViaApi(): Promise<{ rows: VideoRow[]; pages: number; dropped: number }> {
  const kept: VideoRow[] = []
  let pageToken = ''
  let pages     = 0
  let dropped   = 0

  // Keep pulling pages until TARGET survives the Shorts filter, since a page can be
  // mostly Shorts and contribute almost nothing.
  while (pages < MAX_PAGES && kept.length < TARGET) {
    const url =
      `https://www.googleapis.com/youtube/v3/playlistItems` +
      `?part=snippet,contentDetails&playlistId=${UPLOADS}&maxResults=50&key=${YT_KEY}` +
      (pageToken ? `&pageToken=${pageToken}` : '')

    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`YouTube API ${res.status}: ${await res.text()}`)
    const json = await res.json()
    pages++

    const batch: VideoRow[] = []
    for (const item of json.items ?? []) {
      const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId
      const snippet = item.snippet ?? {}
      if (!videoId) continue

      // Private and deleted uploads stay in the playlist but lose their thumbnails.
      const thumb = bestThumb(snippet.thumbnails)
      if (!thumb) continue

      batch.push(row(
        videoId,
        snippet.title ?? '',
        item.contentDetails?.videoPublishedAt ?? snippet.publishedAt ?? null,
        thumb.url, thumb.width, thumb.height,
      ))
    }

    const filtered = await dropShorts(batch)
    kept.push(...filtered.kept)
    dropped += filtered.dropped

    pageToken = json.nextPageToken ?? ''
    if (!pageToken) break
  }

  return { rows: kept.slice(0, TARGET), pages, dropped }
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  // Loud rather than quiet. Without this the run would fail deep inside the fetch with a
  // YouTube error about a missing key, and the only symptom anyone would notice is a
  // gallery that stopped gaining videos — weeks later.
  if (!YT_KEY) {
    return NextResponse.json(
      { ok: false, error: 'YOUTUBE_API_KEY is not set — this sync has no keyless path since YouTube stopped serving the channel RSS feed' },
      { status: 500 },
    )
  }

  try {
    const { rows, pages, dropped } = await fetchViaApi()

    // Nothing is downloaded, so upserting the whole batch is cheap and idempotent — it
    // also repairs titles and thumbnails that changed upstream.
    let upserted = 0
    if (rows.length > 0) {
      const res = await fetch(`${SB_URL}/rest/v1/syrgaca_media`, {
        method:  'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body:    JSON.stringify(rows),
      })
      if (!res.ok) throw new Error(`Supabase upsert ${res.status}: ${await res.text()}`)
      upserted = rows.length
    }

    // Trim anything outside the newest TARGET — including Shorts stored before this
    // filter existed. Safe because the API pages the full backlog, so "not in this batch"
    // genuinely means "no longer among the newest TARGET".
    //
    // Pinned rows are exempt. A pin can point at a video this sync never returns — an
    // older one, or one from a different channel entirely — and without this guard the
    // next run would quietly delete it.
    let pruned = 0
    if (rows.length > 0) {
      const keep = rows.map((r) => `"${r.media_id}"`).join(',')
      const res  = await fetch(
        `${SB_URL}/rest/v1/syrgaca_media?source=eq.youtube&pinned=is.false&media_id=not.in.(${keep})`,
        { method: 'DELETE', headers: { ...HEADERS, Prefer: 'return=representation' } },
      )
      if (res.ok) pruned = ((await res.json()) as unknown[]).length
    }

    return NextResponse.json({ ok: true, pages, videos: rows.length, shortsSkipped: dropped, upserted, pruned })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}

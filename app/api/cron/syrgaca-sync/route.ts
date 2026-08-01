import { NextResponse } from 'next/server'

/**
 * Pulls photos from the Syrian Civil Aviation Authority Facebook page
 * (facebook.com/SyrGACA) into the `syrgaca_media` table as source='facebook'.
 *
 * Videos are deliberately skipped — they come from the authority's YouTube channel
 * instead, via `/api/cron/youtube-sync`, which is free, embeddable and needs no
 * scraping. Taking video from both sources would duplicate every clip, since the two
 * platforms share no id to dedupe on.
 *
 * The page is not one we administer, so the Graph API is unavailable — scraping runs
 * through the Apify `facebook-posts-scraper` actor.
 *
 * Facebook CDN URLs (scontent.*.fbcdn.net) are signed and expire within days, so the
 * bytes are downloaded here and rehosted into the `fb-media` bucket. Only our own URLs
 * are ever persisted.
 *
 * An actor run can outlive the serverless timeout, so the run id is parked in
 * `syrgaca_sync_state` and picked up by the next invocation rather than restarted.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const APIFY_TOKEN = process.env.APIFY_TOKEN
const ACTOR_ID    = 'apify~facebook-posts-scraper'
const PAGE_URL    = 'https://www.facebook.com/SyrGACA/'
const BUCKET      = 'fb-media'

// Only look back a couple of weeks — this runs daily, so anything older is already stored.
const LOOKBACK       = '21 days'
const RESULTS_LIMIT  = 50
// Skip anything implausible for a page photo; protects against pulling a large video file.
const MAX_BYTES      = 12 * 1024 * 1024

// Budgets carved out of maxDuration so the function returns cleanly instead of being
// killed mid-ingest. Leftover work resumes on the next cron tick.
const POLL_DEADLINE_MS   = 180_000
const INGEST_DEADLINE_MS = 275_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── Apify response shapes are loosely typed and drift between actor versions ──────
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRec = Record<string, any>

type MediaRow = {
  media_id:   string
  post_id:    string
  source:     'facebook'
  media_type: 'photo'
  caption:    string | null
  permalink:  string
  posted_at:  string | null
  image_url:  string | null
  thumb_url:  string
  width:      number | null
  height:     number | null
}

// ── Sync state ────────────────────────────────────────────────────────────────
async function readState(): Promise<AnyRec> {
  const res = await fetch(
    `${SB_URL}/rest/v1/syrgaca_sync_state?id=eq.1&select=*`,
    { headers: HEADERS, cache: 'no-store' },
  )
  if (!res.ok) return {}
  const rows = await res.json()
  return rows[0] ?? {}
}

async function writeState(patch: AnyRec) {
  await fetch(`${SB_URL}/rest/v1/syrgaca_sync_state?id=eq.1`, {
    method:  'PATCH',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body:    JSON.stringify(patch),
  })
}

// ── Apify ─────────────────────────────────────────────────────────────────────
async function startRun(): Promise<{ runId: string; datasetId: string }> {
  const res = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        startUrls:          [{ url: PAGE_URL }],
        resultsLimit:       RESULTS_LIMIT,
        onlyPostsNewerThan: LOOKBACK,
      }),
    },
  )
  if (!res.ok) throw new Error(`Apify start failed: ${res.status} ${await res.text()}`)
  const { data } = await res.json()
  return { runId: data.id, datasetId: data.defaultDatasetId }
}

async function pollRun(runId: string, deadline: number) {
  while (Date.now() < deadline) {
    const res = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`, {
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`Apify poll failed: ${res.status}`)
    const { data } = await res.json()
    if (data.status !== 'READY' && data.status !== 'RUNNING') {
      return { status: data.status as string, datasetId: data.defaultDatasetId as string }
    }
    await sleep(5_000)
  }
  return { status: 'RUNNING', datasetId: '' }
}

async function fetchDataset(datasetId: string): Promise<AnyRec[]> {
  const res = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true`,
    { cache: 'no-store' },
  )
  if (!res.ok) throw new Error(`Apify dataset fetch failed: ${res.status}`)
  return res.json()
}

// ── Mapping ───────────────────────────────────────────────────────────────────
// The actor labels videos inconsistently across versions, so check every signal we've
// seen rather than trusting one field.
function isVideo(m: AnyRec): boolean {
  if (m.__typename === 'Video' || m.type === 'Video' || m.type === 'video') return true
  if (m.is_video === true || m.isVideo === true) return true
  if (m.video_url || m.videoUrl || m.playable_url || m.playableUrl) return true
  return typeof m.url === 'string' && /\/(videos|reel)\//.test(m.url)
}

function mediaIdOf(m: AnyRec, postId: string, idx: number): string {
  const direct = m.id ?? m.photo_id ?? m.photoId ?? m.video_id ?? m.videoId
  if (direct) return String(direct)
  const url = typeof m.url === 'string' ? m.url : ''
  const fromUrl =
    url.match(/[?&]fbid=(\d+)/)?.[1] ??
    url.match(/\/(?:photos|videos|reel)\/(?:[^/]+\/)?(\d+)/)?.[1]
  return fromUrl ?? `${postId}-${idx}`
}

function toRows(post: AnyRec): MediaRow[] {
  const postId    = String(post.postId ?? post.post_id ?? post.id ?? '')
  const permalink = post.url ?? post.postUrl ?? post.topLevelUrl
  const media: AnyRec[] = Array.isArray(post.media) ? post.media : []
  if (!postId || !permalink || media.length === 0) return []

  const postedAt = post.time ?? (post.timestamp ? new Date(post.timestamp * 1000).toISOString() : null)
  const caption  = (post.text ?? post.message ?? '').trim() || null

  return media.flatMap((m, idx) => {
    // Videos are YouTube's job — see the note at the top of this file.
    if (isVideo(m)) return []

    const full  = m.uri ?? m.image?.uri ?? m.photo_image?.uri ?? m.thumbnail
    const thumb = m.thumbnail ?? m.thumbnailUrl ?? full
    if (!thumb) return []

    return [{
      media_id:   mediaIdOf(m, postId, idx),
      post_id:    postId,
      source:     'facebook' as const,
      media_type: 'photo' as const,
      caption,
      // Prefer the media's own permalink so a multi-photo post deep-links correctly.
      permalink:  typeof m.url === 'string' && m.url ? m.url : permalink,
      posted_at:  postedAt,
      image_url:  full ?? thumb,
      thumb_url:  thumb,
      width:      m.width ?? m.image?.width ?? null,
      height:     m.height ?? m.image?.height ?? null,
    }]
  })
}

// ── Storage ───────────────────────────────────────────────────────────────────
async function rehost(srcUrl: string, path: string): Promise<string | null> {
  const res = await fetch(srcUrl, { cache: 'no-store' })
  if (!res.ok) return null

  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_BYTES) return null

  const buf = await res.arrayBuffer()
  if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null

  const contentType = res.headers.get('content-type') ?? 'image/jpeg'
  if (!contentType.startsWith('image/')) return null

  const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method:  'POST',
    headers: { ...HEADERS, 'Content-Type': contentType, 'x-upsert': 'true' },
    body:    buf,
  })
  if (!up.ok) return null
  return `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}`
}

async function existingIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const list = ids.map((i) => `"${i}"`).join(',')
  const res  = await fetch(
    `${SB_URL}/rest/v1/syrgaca_media?media_id=in.(${list})&select=media_id`,
    { headers: HEADERS, cache: 'no-store' },
  )
  if (!res.ok) return new Set()
  const rows: { media_id: string }[] = await res.json()
  return new Set(rows.map((r) => r.media_id))
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  const startedAt = Date.now()

  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!APIFY_TOKEN) {
    return NextResponse.json({ ok: false, error: 'APIFY_TOKEN not set' }, { status: 500 })
  }

  try {
    const state = await readState()

    // Resume a run parked by a previous invocation, otherwise kick off a new one.
    let runId: string = state.run_id ?? ''
    if (!runId) {
      const started = await startRun()
      runId = started.runId
      await writeState({ run_id: runId, run_started_at: new Date().toISOString(), last_error: null })
    }

    const { status, datasetId } = await pollRun(runId, startedAt + POLL_DEADLINE_MS)

    if (status === 'RUNNING') {
      // Still going — leave run_id parked so tomorrow's tick collects it.
      return NextResponse.json({ ok: true, pending: true, runId })
    }
    if (status !== 'SUCCEEDED') {
      await writeState({ run_id: null, last_error: `run ${runId} ended ${status}` })
      return NextResponse.json({ ok: false, error: `Apify run ${status}`, runId }, { status: 502 })
    }

    const posts = await fetchDataset(datasetId)
    const rows  = posts.flatMap(toRows)

    // Dedupe within the batch before checking what's already stored.
    const unique = [...new Map(rows.map((r) => [r.media_id, r])).values()]
    const known  = await existingIds(unique.map((r) => r.media_id))
    const fresh  = unique.filter((r) => !known.has(r.media_id))

    let inserted = 0
    let skipped  = 0
    let deferred = 0

    for (const row of fresh) {
      if (Date.now() - startedAt > INGEST_DEADLINE_MS) {
        // Out of budget. run_id stays set, so the next tick re-reads the same dataset
        // and picks up where this left off — already-stored ids are filtered out.
        deferred = fresh.length - inserted - skipped
        break
      }

      const thumb = await rehost(row.thumb_url, `${row.media_id}-t.jpg`)
      if (!thumb) { skipped++; continue }

      const image = !row.image_url || row.image_url === row.thumb_url
        ? thumb
        : await rehost(row.image_url, `${row.media_id}.jpg`) ?? thumb

      const ins = await fetch(`${SB_URL}/rest/v1/syrgaca_media`, {
        method:  'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body:    JSON.stringify({ ...row, thumb_url: thumb, image_url: image }),
      })
      if (ins.ok) inserted++
      else skipped++
    }

    if (deferred === 0) {
      await writeState({ run_id: null, last_synced_at: new Date().toISOString(), last_error: null })
    }

    return NextResponse.json({
      ok: true, runId, posts: posts.length, found: unique.length, inserted, skipped, deferred,
    })
  } catch (e) {
    await writeState({ run_id: null, last_error: String(e) })
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}

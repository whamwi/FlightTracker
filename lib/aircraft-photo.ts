/**
 * Aircraft photo lookup, with the result kept.
 *
 * Both photo routes used to call jetapi.dev and then Planespotters on every request, taking
 * about 1.6 seconds and repeating the work for airframes resolved days earlier. A
 * registration maps to the same photo essentially forever and the same aircraft fly these
 * routes daily, so the answer is worth storing.
 *
 * Misses are stored too, on a much shorter clock. An aircraft with no photo anywhere is
 * otherwise a guaranteed pair of upstream calls on every single view, which is the worst
 * case rather than the rare one.
 *
 * The UPSTREAM url is what gets stored. JetPhotos needs our /api/photo-img proxy to defeat
 * hotlink protection, but that URL carries the request's origin, and a row pinned to one
 * host would be wrong when read from another.
 */

const SB_URL     = process.env.SUPABASE_URL!
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const UA = 'FlightTrackerSY/1.0 (+https://flighttracker-sy.vercel.app)'

/** A found photo is re-checked rarely — repaints and re-registrations do happen. */
export const HIT_TTL_MS  = 60 * 86_400_000
/** A miss is retried sooner: the aircraft may simply not have been photographed yet. */
export const MISS_TTL_MS = 7 * 86_400_000

export interface PhotoRow {
  registration: string
  url:          string | null
  source:       string | null
  needs_proxy:  boolean
  resolved_at:  string
}

/** Whether a stored row can be served as-is. */
export function isFresh(row: Pick<PhotoRow, 'url' | 'resolved_at'>, nowMs: number): boolean {
  const age = nowMs - Date.parse(row.resolved_at)
  if (!Number.isFinite(age)) return false
  return age < (row.url ? HIT_TTL_MS : MISS_TTL_MS)
}

/** Turn a stored row into the URL a client should load. */
export function toClientUrl(row: Pick<PhotoRow, 'url' | 'needs_proxy'>, origin: string): string | null {
  if (!row.url) return null
  return row.needs_proxy
    ? `${origin}/api/photo-img?u=${encodeURIComponent(row.url)}`
    : row.url
}

export interface Resolved { url: string | null; source: string | null; needsProxy: boolean }

/** Ask upstream. Exported so the warmer can resolve without touching the cache read path. */
export async function resolveUpstream(reg: string): Promise<Resolved> {
  // Primary: jetapi.dev — full-res JetPhotos CDN, which must be proxied.
  try {
    const res = await fetch(
      `https://www.jetapi.dev/api?reg=${encodeURIComponent(reg)}&photos=1&only_jp=true`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) },
    )
    if (res.ok) {
      const data = await res.json()
      const cdnUrl: string | null = data?.Images?.[0]?.Image ?? null
      if (cdnUrl) return { url: cdnUrl, source: 'jetapi', needsProxy: true }
    }
  } catch { /* fall through to the secondary source */ }

  // Fallback: Planespotters, which serves its own thumbnails directly.
  try {
    const res = await fetch(
      `https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(reg)}`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) },
    )
    if (res.ok) {
      const data = await res.json()
      const url: string | null =
        data?.photos?.[0]?.thumbnail_large?.src ?? data?.photos?.[0]?.thumbnail?.src ?? null
      if (url) return { url, source: 'planespotters', needsProxy: false }
    }
  } catch { /* a miss is a normal outcome */ }

  return { url: null, source: null, needsProxy: false }
}

async function readRow(reg: string): Promise<PhotoRow | null> {
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/aircraft_photos?registration=eq.${encodeURIComponent(reg)}&select=*&limit=1`,
      { headers: SB_HEADERS, signal: AbortSignal.timeout(4000) },
    )
    if (!res.ok) return null
    const rows: PhotoRow[] = await res.json()
    return rows[0] ?? null
  } catch { return null }
}

export async function writeRow(reg: string, r: Resolved): Promise<void> {
  try {
    await fetch(`${SB_URL}/rest/v1/aircraft_photos`, {
      method: 'POST',
      headers: {
        ...SB_HEADERS,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        registration: reg,
        url:          r.url,
        source:       r.source,
        needs_proxy:  r.needsProxy,
        resolved_at:  new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(4000),
    })
  } catch { /* the cache is an optimisation; failing to write it must not fail the request */ }
}

/**
 * The photo URL for a registration, from the cache when it can be.
 *
 * A stale row is refreshed, but if the refresh finds nothing the stale value is still
 * returned — an old photo of the right aircraft beats no photo because an upstream API was
 * briefly unavailable.
 */
export async function photoForReg(reg: string, origin: string): Promise<string | null> {
  const row = await readRow(reg)
  if (row && isFresh(row, Date.now())) return toClientUrl(row, origin)

  const resolved = await resolveUpstream(reg)
  if (resolved.url || !row) {
    await writeRow(reg, resolved)
    return toClientUrl({ url: resolved.url, needs_proxy: resolved.needsProxy }, origin)
  }
  return toClientUrl(row, origin)
}

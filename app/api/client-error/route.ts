import { NextResponse } from 'next/server'

/**
 * Where the web and the app report what went wrong for a user.
 *
 * Open by necessity — a browser that has just thrown cannot authenticate, and requiring a
 * secret would mean shipping one in public JavaScript, which protects nothing. Reading is what
 * matters, and that lives behind Basic auth on /admin/errors.
 *
 * Open does mean abusable, so this deliberately keeps very little and caps what it keeps:
 * a flood costs rows, not money, and nothing here is worth stealing.
 */

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

/** One report is one row; a batch from the app's log is capped so a loop cannot dump megabytes. */
const MAX_BATCH   = 50
const MAX_MESSAGE = 2_000
const MAX_STACK   = 8_000

type Incoming = {
  platform?: string
  release?: string
  kind?: string
  message?: string
  stack?: string
  path?: string
  session_id?: string
  context?: unknown
}

const PLATFORMS = new Set(['web', 'ios', 'android'])
// OFFLINE: a fetch that failed while the tab was hidden or the phone had no signal. Kept
// rather than dropped — a rise in these says something about our users' networks — but not
// an ERROR, which is what let them bury the one real defect in the table.
const KINDS     = new Set(['ERROR', 'WARN', 'GONE', 'VANISHED', 'RECOVERED', 'BOOT', 'OFFLINE'])

const clip = (s: unknown, max: number): string | null =>
  typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : null

/**
 * Normalise one report.
 *
 * Everything is treated as untrusted string data — it arrives from a public endpoint and is
 * rendered on an admin page later. Unknown platforms and kinds are coerced rather than
 * rejected: a malformed field is no reason to lose the error it describes.
 */
function clean(r: Incoming) {
  const message = clip(r.message, MAX_MESSAGE)
  if (!message) return null
  const platform = typeof r.platform === 'string' && PLATFORMS.has(r.platform) ? r.platform : 'web'
  const kind     = typeof r.kind === 'string' && KINDS.has(r.kind) ? r.kind : 'ERROR'
  return {
    platform,
    kind,
    message,
    release:    clip(r.release, 60),
    stack:      clip(r.stack, MAX_STACK),
    path:       clip(r.path, 300),
    session_id: clip(r.session_id, 64),
    // Bounded by serialising and re-parsing: an arbitrarily deep object from a public endpoint
    // is not something to hand to the database unchecked.
    context:    r.context && typeof r.context === 'object'
      ? JSON.parse(JSON.stringify(r.context).slice(0, 4_000).replace(/[^}\]"]*$/, '') || '{}')
      : null,
  }
}

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 })
  }

  const list: Incoming[] = Array.isArray(body) ? body : [body as Incoming]
  const rows = list.slice(0, MAX_BATCH).map(clean).filter(Boolean)
  if (!rows.length) return NextResponse.json({ ok: true, stored: 0 })

  const res = await fetch(`${SB_URL}/rest/v1/client_error`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  })

  // Checked rather than fire-and-forget: an error reporter that silently fails to report is
  // worse than none, because it looks like quiet.
  if (!res.ok) {
    console.error('[client-error] write failed', res.status, (await res.text()).slice(0, 200))
    return NextResponse.json({ ok: false }, { status: 502 })
  }
  return NextResponse.json({ ok: true, stored: rows.length })
}

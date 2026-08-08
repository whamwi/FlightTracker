import { SYRIA_AIRPORTS_CSV } from '@/lib/syria-airports'

/**
 * What is going wrong for users, newest first.
 *
 * Vercel's runtime logs answer for the server, briefly. They cannot see a JavaScript error in a
 * browser in Damascus or a failed request inside the app, which is most of what actually breaks
 * — and until this page, the only reason any of it was ever noticed was one person happening to
 * be looking at the right screen.
 *
 * Behind the same Basic auth as the rest of /admin, via middleware.ts.
 *
 * Server-rendered on every request rather than a client page polling an endpoint: this is read
 * a few times a week, and an admin page that needs its own API is a second thing to secure.
 */

export const dynamic  = 'force-dynamic'
export const revalidate = 0

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!

const C = {
  bg: '#0d1117', panel: '#161b22', border: '#30363d',
  ink: '#e6edf3', muted: '#8b949e', dim: '#6e7681',
  red: '#f85149', amber: '#d29922', green: '#3fb950', blue: '#58a6ff',
}

type Row = {
  id: number
  created_at: string
  platform: string
  release: string | null
  kind: string
  message: string
  stack: string | null
  path: string | null
  session_id: string | null
  context: Record<string, unknown> | null
}

const KIND_COLOUR: Record<string, string> = {
  ERROR: C.red, WARN: C.amber, VANISHED: C.amber,
  GONE: C.dim, RECOVERED: C.green, BOOT: C.blue,
  OFFLINE: C.dim,
}

async function fetchRows(platform: string | null, hours: number): Promise<Row[] | null> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString()
  const q = new URLSearchParams({
    select: '*',
    created_at: `gte.${since}`,
    order: 'created_at.desc',
    limit: '300',
  })
  if (platform) q.set('platform', `eq.${platform}`)

  try {
    const res = await fetch(`${SB_URL}/rest/v1/client_error?${q}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      cache: 'no-store',
    })
    // null rather than [] so "the query failed" cannot be read as "no errors" — which is the
    // most dangerous thing a page like this could get wrong.
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function damascus(iso: string): string {
  const d = new Date(Date.parse(iso) + 3 * 3_600_000)
  return d.toISOString().slice(5, 16).replace('T', ' ')
}

export default async function ErrorsPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string; hours?: string }>
}) {
  const sp       = await searchParams
  const platform = sp.platform && sp.platform !== 'all' ? sp.platform : null
  const hours    = Math.min(Number(sp.hours) || 24, 720)
  const rows     = await fetchRows(platform, hours)

  // Grouped by message so one bug hitting fifty people reads as one bug, with a count — the
  // single most useful thing this page does, and what a raw log cannot tell you.
  const groups = new Map<string, { rows: Row[]; sessions: Set<string> }>()
  for (const r of rows ?? []) {
    const key = `${r.kind}|${r.message}`
    if (!groups.has(key)) groups.set(key, { rows: [], sessions: new Set() })
    const g = groups.get(key)!
    g.rows.push(r)
    if (r.session_id) g.sessions.add(r.session_id)
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].rows.length - a[1].rows.length)

  const tab = (label: string, href: string, on: boolean) => (
    <a key={label} href={href} style={{
      padding: '6px 12px', borderRadius: 7, textDecoration: 'none',
      background: on ? C.blue : 'transparent', color: on ? '#04121f' : C.muted,
      border: `1px solid ${on ? C.blue : C.border}`, fontWeight: on ? 700 : 500, fontSize: 13,
    }}>{label}</a>
  )

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.ink, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '28px 22px' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>

        <h1 style={{ fontSize: 19, fontWeight: 700, margin: '0 0 4px' }}>Client errors</h1>
        <p style={{ color: C.muted, fontSize: 12.5, margin: '0 0 18px' }}>
          Reported by browsers and by the app. Server-side faults are in Vercel → Observability → Runtime Logs.
        </p>

        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 8 }}>
          {['all', 'web', 'ios', 'android'].map(p =>
            tab(p, `?platform=${p}&hours=${hours}`, (platform ?? 'all') === p))}
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 20 }}>
          {[[1, '1h'], [24, '24h'], [168, '7d'], [720, '30d']].map(([h, label]) =>
            tab(String(label), `?platform=${platform ?? 'all'}&hours=${h}`, hours === h))}
        </div>

        {rows === null ? (
          <div style={{ padding: 16, borderRadius: 9, border: `1px solid ${C.red}`, color: C.red, fontSize: 13 }}>
            Could not read the error table. This is not the same as “no errors” — the query itself failed.
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 22, borderRadius: 9, border: `1px solid ${C.border}`, background: C.panel, color: C.muted, fontSize: 13 }}>
            Nothing reported in the last {hours}h{platform ? ` from ${platform}` : ''}.
          </div>
        ) : (
          <>
            <div style={{ color: C.muted, fontSize: 12.5, marginBottom: 12 }}>
              {rows.length} report{rows.length === 1 ? '' : 's'} · {sorted.length} distinct
              {rows.length >= 300 && ' · showing the most recent 300'}
            </div>

            {sorted.map(([key, g]) => {
              const first = g.rows[0]
              const colour = KIND_COLOUR[first.kind] ?? C.muted
              return (
                <details key={key} style={{ marginBottom: 10, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 9, overflow: 'hidden' }}>
                  <summary style={{ padding: '12px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ color: colour, fontWeight: 700, fontSize: 11, letterSpacing: '.06em' }}>{first.kind}</span>
                    <span style={{ flex: 1, minWidth: 220, fontSize: 13 }}>{first.message}</span>
                    <span style={{ color: C.muted, fontSize: 11.5 }}>
                      {g.rows.length}× · {g.sessions.size || '?'} session{g.sessions.size === 1 ? '' : 's'}
                    </span>
                    <span style={{ color: C.dim, fontSize: 11.5 }}>{damascus(first.created_at)}</span>
                  </summary>

                  <div style={{ borderTop: `1px solid ${C.border}`, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11.5, color: C.muted }}>
                      <span>platform <b style={{ color: C.ink }}>{first.platform}</b></span>
                      {first.release && <span>release <b style={{ color: C.ink }}>{first.release}</b></span>}
                      {first.path && <span>path <b style={{ color: C.ink }}>{first.path}</b></span>}
                    </div>

                    {first.stack && (
                      <pre style={{ margin: 0, padding: 10, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 11, lineHeight: 1.5, overflowX: 'auto', color: C.muted }}>
                        {first.stack}
                      </pre>
                    )}

                    {first.context && (
                      <pre style={{ margin: 0, padding: 10, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 11, overflowX: 'auto', color: C.muted }}>
                        {JSON.stringify(first.context, null, 2)}
                      </pre>
                    )}

                    {g.rows.length > 1 && (
                      <div style={{ fontSize: 11.5, color: C.dim }}>
                        Also at {g.rows.slice(1, 9).map(r => damascus(r.created_at)).join(' · ')}
                        {g.rows.length > 9 ? ` and ${g.rows.length - 9} more` : ''}
                      </div>
                    )}
                  </div>
                </details>
              )
            })}
          </>
        )}

        <p style={{ color: C.dim, fontSize: 11, marginTop: 26 }}>
          Nothing here identifies a person. session_id is random per page load and stored nowhere else.
          Airports covered: {SYRIA_AIRPORTS_CSV}.
        </p>
      </div>
    </div>
  )
}

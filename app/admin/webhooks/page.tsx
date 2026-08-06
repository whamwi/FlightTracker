/**
 * What a provider's push actually sends, and how often.
 *
 * The number that decides between VariFlight and AirLabs is not on either pricing page:
 * how many notifications does one flight generate in a day? VariFlight bills per flight and
 * does not care; AirLabs bills per webhook, so that count is the price. This page counts them.
 *
 * The per-flight average is the figure to read. At one or two pushes per flight the
 * per-notification model is cheaper; at ten it is several times more expensive, and the
 * flights that push most are the delayed ones people actually subscribe to.
 *
 * Behind the same Basic auth as the rest of /admin.
 */

export const dynamic    = 'force-dynamic'
export const revalidate = 0

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!

const C = {
  bg: '#0d1117', panel: '#161b22', border: '#30363d',
  ink: '#e6edf3', muted: '#8b949e', dim: '#6e7681', blue: '#58a6ff', amber: '#d29922',
}

type Row = {
  id: number
  received_at: string
  provider: string
  flight_iata: string | null
  flight_icao: string | null
  dep_iata: string | null
  arr_iata: string | null
  status: string | null
  changed: string[] | null
  payload: Record<string, unknown>
}

async function fetchRows(hours: number): Promise<Row[] | null> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString()
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/flight_webhook_event?received_at=gte.${since}` +
      `&select=*&order=received_at.desc&limit=500`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, cache: 'no-store' },
    )
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

const damascus = (iso: string) =>
  new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(5, 19).replace('T', ' ')

export default async function WebhooksPage({
  searchParams,
}: { searchParams: Promise<{ hours?: string }> }) {
  const hours = Math.min(Number((await searchParams).hours) || 24, 720)
  const rows  = await fetchRows(hours)

  // Per provider: how many pushes, for how many distinct flights, and what changed.
  const byProvider = new Map<string, { n: number; flights: Set<string>; fields: Map<string, number> }>()
  for (const r of rows ?? []) {
    if (!byProvider.has(r.provider)) {
      byProvider.set(r.provider, { n: 0, flights: new Set(), fields: new Map() })
    }
    const p = byProvider.get(r.provider)!
    p.n++
    const key = r.flight_iata ?? r.flight_icao
    if (key) p.flights.add(key)
    for (const f of r.changed ?? []) p.fields.set(f, (p.fields.get(f) ?? 0) + 1)
  }

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.ink, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '28px 22px' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <h1 style={{ fontSize: 19, fontWeight: 700, margin: '0 0 4px' }}>Provider webhooks</h1>
        <p style={{ color: C.muted, fontSize: 12.5, margin: '0 0 18px' }}>
          Pushes received in the last {hours}h. The pushes-per-flight figure is what decides
          between per-flight and per-notification pricing.
        </p>

        <div style={{ display: 'flex', gap: 7, marginBottom: 20 }}>
          {[[1, '1h'], [24, '24h'], [168, '7d']].map(([h, label]) => (
            <a key={String(label)} href={`?hours=${h}`} style={{
              padding: '6px 12px', borderRadius: 7, textDecoration: 'none', fontSize: 13,
              border: `1px solid ${hours === h ? C.blue : C.border}`,
              background: hours === h ? C.blue : 'transparent',
              color: hours === h ? '#04121f' : C.muted, fontWeight: hours === h ? 700 : 500,
            }}>{label}</a>
          ))}
        </div>

        {rows === null ? (
          <div style={{ padding: 16, borderRadius: 9, border: '1px solid #f85149', color: '#f85149', fontSize: 13 }}>
            Could not read the table. This is not the same as “no pushes”.
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 22, borderRadius: 9, border: `1px solid ${C.border}`, background: C.panel, color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
            Nothing received yet. Point a provider at:
            <div style={{ marginTop: 10, color: C.ink }}>
              https://www.flysyria.app/api/flight-webhook?provider=airlabs&amp;token=…
            </div>
          </div>
        ) : (
          <>
            {[...byProvider.entries()].map(([provider, p]) => {
              const perFlight = p.flights.size ? p.n / p.flights.size : 0
              return (
                <div key={provider} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 9, padding: '14px 16px', marginBottom: 14 }}>
                  <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{provider}</span>
                    <span style={{ color: C.muted, fontSize: 12.5 }}>{p.n} pushes</span>
                    <span style={{ color: C.muted, fontSize: 12.5 }}>{p.flights.size} flights</span>
                    <span style={{ color: C.amber, fontSize: 13, fontWeight: 700 }}>
                      {perFlight.toFixed(1)} per flight
                    </span>
                  </div>
                  {p.fields.size > 0 && (
                    <div style={{ marginTop: 9, color: C.dim, fontSize: 11.5 }}>
                      changed: {[...p.fields.entries()].sort((a, b) => b[1] - a[1])
                        .map(([f, n]) => `${f}×${n}`).join('  ')}
                    </div>
                  )}
                </div>
              )
            })}

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: C.muted, textAlign: 'left' }}>
                  {['received', 'provider', 'flight', 'route', 'status', 'changed'].map(h => (
                    <th key={h} style={{ padding: '7px 9px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 200).map(r => (
                  <tr key={r.id}>
                    <td style={{ padding: '6px 9px', borderBottom: `1px solid ${C.border}`, color: C.dim }}>{damascus(r.received_at)}</td>
                    <td style={{ padding: '6px 9px', borderBottom: `1px solid ${C.border}` }}>{r.provider}</td>
                    <td style={{ padding: '6px 9px', borderBottom: `1px solid ${C.border}`, color: C.blue }}>{r.flight_iata ?? r.flight_icao ?? '—'}</td>
                    <td style={{ padding: '6px 9px', borderBottom: `1px solid ${C.border}` }}>{r.dep_iata ?? '?'}→{r.arr_iata ?? '?'}</td>
                    <td style={{ padding: '6px 9px', borderBottom: `1px solid ${C.border}` }}>{r.status ?? '—'}</td>
                    <td style={{ padding: '6px 9px', borderBottom: `1px solid ${C.border}`, color: C.muted }}>{(r.changed ?? []).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}

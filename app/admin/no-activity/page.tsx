/**
 * Flights the timetable promised and the day did not deliver.
 *
 * Two things are counted here and they must not be added together: an airline
 * cancelling a real service, and a route_master row for a service that has never operated.
 * The second is our own bookkeeping and repeats every scheduled weekday, so it is reported in
 * its own section — a number sent outside the building has to mean what it says.
 *
 * Server-rendered like /admin/errors, behind the same Basic auth via middleware.ts. It reads
 * /api/admin/no-activity, which holds the aggregation.
 */

export const dynamic    = 'force-dynamic'
export const revalidate = 0

const C = {
  bg: '#0d1117', panel: '#161b22', border: '#30363d',
  ink: '#e6edf3', muted: '#8b949e', dim: '#6e7681',
  red: '#f85149', amber: '#d29922', green: '#3fb950', blue: '#58a6ff',
}

type Month = {
  month: string; cancellations: number; unverified_schedule: number
  flew_late: number; still_open: number
}
type Flight = { num: string; route: string; count: number; ever_flown: boolean; dates: string[] }
type Row = {
  id: number; flight_date: string; iata_number: string
  dep_iata: string | null; arr_iata: string | null; sched_dep_utc: string | null
  outcome: string | null; resolved_reason: string | null; hours_overdue: number | null
}

const OUTCOME_COLOUR: Record<string, string> = {
  did_not_operate:   C.red,
  flew_late:         C.amber,
  activity_appeared: C.green,
}

async function load(): Promise<{
  months: Month[]; cancellations: Flight[]; unverified_schedule: Flight[]; rows: Row[]
} | null> {
  // Same-origin absolute URL, because a server component has no relative base.
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'
  try {
    const res = await fetch(`${base}/api/admin/no-activity`, {
      cache: 'no-store',
      // The middleware gate sits in front of /api/admin too, so this call has to carry it.
      headers: {
        Authorization: 'Basic ' + Buffer.from(
          `${process.env.ADMIN_USERNAME ?? 'admin'}:${process.env.ADMIN_PASSWORD ?? 'changeme'}`
        ).toString('base64'),
      },
    })
    if (!res.ok) return null
    const d = await res.json()
    return d.ok ? d : null
  } catch { return null }
}

function Panel({ title, subtitle, children }: {
  title: string; subtitle?: string; children: React.ReactNode
}) {
  return (
    <section style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
      <h2 style={{ margin: 0, fontSize: 15, color: C.ink }}>{title}</h2>
      {subtitle && <p style={{ margin: '4px 0 14px', fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>{subtitle}</p>}
      {children}
    </section>
  )
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '6px 10px', fontSize: 11, textTransform: 'uppercase',
  letterSpacing: '.06em', color: C.dim, borderBottom: `1px solid ${C.border}`, fontWeight: 600,
}
const td: React.CSSProperties = { padding: '7px 10px', fontSize: 13, color: C.ink, borderBottom: `1px solid ${C.border}` }

export default async function NoActivityPage() {
  const data = await load()

  return (
    <main style={{ background: C.bg, minHeight: '100vh', padding: '28px 22px', fontFamily: 'ui-sans-serif, system-ui' }}>
      <h1 style={{ margin: '0 0 4px', fontSize: 20, color: C.ink }}>Scheduled and never flown</h1>
      <p style={{ margin: '0 0 22px', fontSize: 13, color: C.muted, maxWidth: 680, lineHeight: 1.55 }}>
        A flight is flagged when the day ends with no departure and no arrival, and given a
        verdict twelve hours past its scheduled departure. Cancellations and unverified
        timetable rows are counted separately — only the first is an airline not flying.
      </p>

      {!data ? (
        <p style={{ color: C.red, fontSize: 14 }}>Could not load. Check ADMIN_USERNAME / ADMIN_PASSWORD are set.</p>
      ) : (
        <>
          <Panel title="By month">
            {data.months.length === 0
              ? <p style={{ color: C.dim, fontSize: 13, margin: 0 }}>Nothing recorded yet.</p>
              : (
                <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: 720 }}>
                  <thead><tr>
                    <th style={th}>Month</th>
                    <th style={th}>Cancelled</th>
                    <th style={th}>Unverified schedule</th>
                    <th style={th}>Flew late</th>
                    <th style={th}>Still open</th>
                  </tr></thead>
                  <tbody>
                    {data.months.map(m => (
                      <tr key={m.month}>
                        <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{m.month}</td>
                        <td style={{ ...td, color: m.cancellations ? C.red : C.dim, fontWeight: 600 }}>{m.cancellations}</td>
                        <td style={{ ...td, color: m.unverified_schedule ? C.amber : C.dim }}>{m.unverified_schedule}</td>
                        <td style={{ ...td, color: C.muted }}>{m.flew_late}</td>
                        <td style={{ ...td, color: C.dim }}>{m.still_open}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </Panel>

          <Panel
            title="Cancellations"
            subtitle="Services that have operated before and did not on these dates. This is the number that means an airline cancelled."
          >
            <FlightTable flights={data.cancellations} empty="No cancellations recorded." />
          </Panel>

          <Panel
            title="Unverified schedule"
            subtitle="Flight numbers in route_master that have never once been seen airborne. Almost always a timetable entry to correct, not a cancellation — these are excluded from the figure above."
          >
            <FlightTable flights={data.unverified_schedule} empty="No unverified routes." />
          </Panel>

          <Panel title="Did not operate" subtitle={`${data.rows.length} in range, newest first. Flights that flew late are counted above, not listed here.`}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr>
                <th style={th}>Date</th><th style={th}>Flight</th><th style={th}>Route</th>
                <th style={th}>Sched dep</th><th style={th}>Outcome</th><th style={th}>Reason</th>
              </tr></thead>
              <tbody>
                {data.rows.map(r => (
                  <tr key={r.id}>
                    <td style={{ ...td, fontFamily: 'ui-monospace, monospace', color: C.muted }}>{r.flight_date}</td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{r.iata_number}</td>
                    <td style={{ ...td, color: C.muted }}>{r.dep_iata ?? '?'}→{r.arr_iata ?? '?'}</td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, monospace', color: C.muted }}>{r.sched_dep_utc ?? '—'}</td>
                    <td style={{ ...td, color: OUTCOME_COLOUR[r.outcome ?? ''] ?? C.dim, fontWeight: 600 }}>
                      {r.outcome ?? 'open'}
                    </td>
                    <td style={{ ...td, color: C.dim, fontSize: 12 }}>{r.resolved_reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </main>
  )
}

function FlightTable({ flights, empty }: { flights: Flight[]; empty: string }) {
  if (!flights.length) return <p style={{ color: C.dim, fontSize: 13, margin: 0 }}>{empty}</p>
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: 820 }}>
      <thead><tr>
        <th style={th}>Flight</th><th style={th}>Route</th><th style={th}>Times</th><th style={th}>Dates</th>
      </tr></thead>
      <tbody>
        {flights.map(f => (
          <tr key={f.num}>
            <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{f.num}</td>
            <td style={{ ...td, color: C.muted }}>{f.route}</td>
            <td style={{ ...td, fontWeight: 600 }}>{f.count}</td>
            <td style={{ ...td, color: C.dim, fontSize: 12 }}>{f.dates.join(', ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

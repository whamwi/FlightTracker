'use client'

import { useEffect, useState, useCallback } from 'react'

interface UnfiledRow {
  id:              number
  flight_date:     string
  iata_number:     string
  dep_iata:        string
  arr_iata:        string
  sched_dep_utc:   string | null
  sched_arr_utc:   string | null
  duration_min:    number | null
  day_of_week:     string | null
  route_master_id: number | null
  rm_dep_time_utc: string | null
  rm_arr_time_utc: string | null
  diff_minutes:    number | null
  reason:          'time_drift' | 'new_route'
  reviewed:        boolean
  created_at:      string
}

const DOW: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu',
  fri: 'Fri', sat: 'Sat', sun: 'Sun',
}

function hhmm(t: string | null): string {
  if (!t) return '—'
  return t.slice(0, 5)
}

function localTime(utc: string | null): string {
  if (!utc) return '—'
  const [h, m] = utc.slice(0, 5).split(':').map(Number)
  const local = ((h * 60 + m) + 3 * 60) % 1440
  return `${String(Math.floor(local / 60)).padStart(2, '0')}:${String(local % 60).padStart(2, '0')}`
}

function diffBadge(min: number | null) {
  if (min === null) return null
  const color = min >= 30 ? '#ef4444' : min >= 20 ? '#f97316' : '#eab308'
  return (
    <span style={{ background: color, color: '#fff', borderRadius: 4, padding: '2px 7px', fontSize: 12, fontWeight: 700 }}>
      {min}m
    </span>
  )
}

const s: Record<string, React.CSSProperties> = {
  page:    { fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', maxWidth: 1100, margin: '0 auto', padding: '24px 20px', color: '#111' },
  h1:      { fontSize: 22, fontWeight: 700, marginBottom: 4 },
  sub:     { color: '#666', fontSize: 14, marginBottom: 24 },
  stats:   { display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' as const },
  stat:    { background: '#f4f4f4', borderRadius: 8, padding: '12px 20px', minWidth: 100 },
  statN:   { fontSize: 28, fontWeight: 700, lineHeight: 1 },
  statL:   { fontSize: 12, color: '#888', marginTop: 2, textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  tabs:    { display: 'flex', gap: 0, borderBottom: '2px solid #e5e5e5', marginBottom: 20 },
  tab:     { padding: '8px 20px', cursor: 'pointer', fontWeight: 600, fontSize: 14, border: 'none', background: 'none', color: '#888' },
  tabA:    { padding: '8px 20px', cursor: 'pointer', fontWeight: 600, fontSize: 14, border: 'none', background: 'none', color: '#111', borderBottom: '2px solid #111', marginBottom: -2 },
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 },
  table:   { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  th:      { background: '#eee', padding: '8px 10px', textAlign: 'left' as const, fontWeight: 600, fontSize: 12, textTransform: 'uppercase' as const, letterSpacing: '0.04em', whiteSpace: 'nowrap' as const },
  td:      { padding: '8px 10px', borderBottom: '1px solid #f0f0f0', verticalAlign: 'middle' as const },
  tdDim:   { padding: '8px 10px', borderBottom: '1px solid #f0f0f0', verticalAlign: 'middle' as const, color: '#999' },
  btn:     { padding: '4px 10px', borderRadius: 5, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 500 },
  btnDone: { padding: '4px 10px', borderRadius: 5, border: '1px solid #d1fae5', background: '#d1fae5', cursor: 'default', fontSize: 12, fontWeight: 500, color: '#065f46' },
  chip:    { display: 'inline-block', borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 600 },
}

export default function ReconcilePage() {
  const [rows, setRows]           = useState<UnfiledRow[]>([])
  const [loading, setLoading]     = useState(true)
  const [tab, setTab]             = useState<'time_drift' | 'new_route'>('time_drift')
  const [hideReviewed, setHide]   = useState(true)
  const [saving, setSaving]       = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/admin/reconcile')
    if (res.ok) {
      const data = await res.json()
      setRows(data.rows ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function markReviewed(id: number) {
    setSaving(id)
    await fetch('/api/admin/reconcile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, reviewed: true }),
    })
    setRows(prev => prev.map(r => r.id === id ? { ...r, reviewed: true } : r))
    setSaving(null)
  }

  const driftRows   = rows.filter(r => r.reason === 'time_drift')
  const newRows     = rows.filter(r => r.reason === 'new_route')
  const displayed   = (tab === 'time_drift' ? driftRows : newRows)
    .filter(r => hideReviewed ? !r.reviewed : true)

  const pendingDrift = driftRows.filter(r => !r.reviewed).length
  const pendingNew   = newRows.filter(r => !r.reviewed).length

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Schedule Reconciliation</h1>
      <p style={s.sub}>
        Flights from <code>fr24_daily_cache</code> that differ from <code>route_master</code>.
        Review daily before automating any updates.
      </p>

      {/* Stats */}
      <div style={s.stats}>
        <div style={s.stat}>
          <div style={{ ...s.statN, color: pendingDrift > 0 ? '#f97316' : '#16a34a' }}>{pendingDrift}</div>
          <div style={s.statL}>Pending drift</div>
        </div>
        <div style={s.stat}>
          <div style={{ ...s.statN, color: pendingNew > 0 ? '#3b82f6' : '#16a34a' }}>{pendingNew}</div>
          <div style={s.statL}>Pending new routes</div>
        </div>
        <div style={s.stat}>
          <div style={{ ...s.statN, color: '#16a34a' }}>{rows.filter(r => r.reviewed).length}</div>
          <div style={s.statL}>Reviewed</div>
        </div>
        <div style={s.stat}>
          <div style={s.statN}>{rows.length}</div>
          <div style={s.statL}>Total logged</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={s.tabs}>
        <button style={tab === 'time_drift' ? s.tabA : s.tab} onClick={() => setTab('time_drift')}>
          Time Drift ({pendingDrift} pending)
        </button>
        <button style={tab === 'new_route' ? s.tabA : s.tab} onClick={() => setTab('new_route')}>
          New Routes ({pendingNew} pending)
        </button>
      </div>

      {/* Toolbar */}
      <div style={s.toolbar}>
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={hideReviewed} onChange={e => setHide(e.target.checked)} />
          Hide reviewed
        </label>
        <span style={{ color: '#999', fontSize: 13 }}>
          {displayed.length} row{displayed.length !== 1 ? 's' : ''}
        </span>
        <button style={{ ...s.btn, marginLeft: 'auto' }} onClick={load}>↻ Refresh</button>
      </div>

      {/* Table */}
      {loading ? (
        <p style={{ color: '#999' }}>Loading…</p>
      ) : displayed.length === 0 ? (
        <p style={{ color: '#999', padding: '32px 0', textAlign: 'center' }}>
          {hideReviewed ? 'All caught up — nothing pending review.' : 'No entries yet.'}
        </p>
      ) : tab === 'time_drift' ? (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Date</th>
              <th style={s.th}>Flight</th>
              <th style={s.th}>Route</th>
              <th style={s.th}>Day</th>
              <th style={s.th}>Cache (local)</th>
              <th style={s.th}>Route Master</th>
              <th style={s.th}>Drift</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {displayed.map(r => (
              <tr key={r.id} style={{ opacity: r.reviewed ? 0.45 : 1 }}>
                <td style={s.tdDim}>{r.flight_date}</td>
                <td style={{ ...s.td, fontFamily: 'monospace', fontWeight: 600 }}>{r.iata_number}</td>
                <td style={s.td}>{r.dep_iata} → {r.arr_iata}</td>
                <td style={s.tdDim}>{DOW[r.day_of_week ?? ''] ?? r.day_of_week}</td>
                <td style={{ ...s.td, color: '#2563eb', fontWeight: 600 }}>
                  {localTime(r.sched_dep_utc)}
                  <span style={{ color: '#999', fontWeight: 400 }}> ({hhmm(r.sched_dep_utc)} UTC)</span>
                </td>
                <td style={s.tdDim}>
                  {localTime(r.rm_dep_time_utc)}
                  <span style={{ color: '#ccc' }}> ({hhmm(r.rm_dep_time_utc)} UTC)</span>
                </td>
                <td style={s.td}>{diffBadge(r.diff_minutes)}</td>
                <td style={s.td}>
                  {r.reviewed
                    ? <span style={s.btnDone}>✓ Reviewed</span>
                    : <button style={s.btn} disabled={saving === r.id} onClick={() => markReviewed(r.id)}>
                        {saving === r.id ? '…' : 'Mark reviewed'}
                      </button>
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Date</th>
              <th style={s.th}>Flight</th>
              <th style={s.th}>Route</th>
              <th style={s.th}>Day</th>
              <th style={s.th}>Dep (local)</th>
              <th style={s.th}>Arr (local)</th>
              <th style={s.th}>Duration</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {displayed.map(r => (
              <tr key={r.id} style={{ opacity: r.reviewed ? 0.45 : 1 }}>
                <td style={s.tdDim}>{r.flight_date}</td>
                <td style={{ ...s.td, fontFamily: 'monospace', fontWeight: 600 }}>{r.iata_number}</td>
                <td style={s.td}>{r.dep_iata} → {r.arr_iata}</td>
                <td style={s.tdDim}>{DOW[r.day_of_week ?? ''] ?? r.day_of_week}</td>
                <td style={{ ...s.td, color: '#2563eb', fontWeight: 600 }}>{localTime(r.sched_dep_utc)}</td>
                <td style={{ ...s.td, color: '#2563eb', fontWeight: 600 }}>{localTime(r.sched_arr_utc)}</td>
                <td style={s.tdDim}>{r.duration_min ? `${Math.floor(r.duration_min / 60)}h ${r.duration_min % 60}m` : '—'}</td>
                <td style={s.td}>
                  {r.reviewed
                    ? <span style={s.btnDone}>✓ Reviewed</span>
                    : <button style={s.btn} disabled={saving === r.id} onClick={() => markReviewed(r.id)}>
                        {saving === r.id ? '…' : 'Mark reviewed'}
                      </button>
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

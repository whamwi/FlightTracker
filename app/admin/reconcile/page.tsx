'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { airportOffset, loadGeoData } from '@/lib/geo-data'

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

/**
 * The time at the airport it belongs to.
 *
 * This assumed +3 for everything, which is right for Syria and wrong for a third of the
 * network. An Abu Dhabi departure showed as 09:45 when the airport clock said 10:45, so
 * reviewing an AUH or DXB row meant comparing a number against a timetable that disagreed
 * with it by an hour — on a page whose entire purpose is spotting an hour-sized mistake.
 *
 * The drift figures were never affected: those are computed in UTC. Only the review column
 * was lying.
 *
 * Falls back to +3 when the offset is unknown, which is the old behaviour and correct for the
 * Syrian ends — but the airports table has the real value for every airport we serve.
 */
function localTime(utc: string | null, iata?: string): string {
  if (!utc) return '—'
  const [h, m] = utc.slice(0, 5).split(':').map(Number)
  const offset = (iata ? airportOffset[iata] : undefined) ?? 3
  const local = (((h * 60 + m) + offset * 60) % 1440 + 1440) % 1440
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
  btnDel:  { padding: '4px 10px', borderRadius: 5, border: '1px solid #fecaca', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: '#dc2626' },
  chip:    { display: 'inline-block', borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 600 },
}

/** A flight that was scheduled yesterday and produced no departure and no arrival. */
interface IdleRow {
  id: number; flight_date: string; iata_number: string; callsign: string | null
  dep_iata: string | null; arr_iata: string | null
  sched_dep_utc: string | null; status: string | null
  hours_overdue: number | null; resolved_at: string | null; resolved_reason: string | null
}

interface RouteGroup {
  key: string
  iata_number: string
  dep_iata: string
  arr_iata: string
  dep_utc: string
  arr_utc: string
  duration_min: number | null
  days: string[]
  ids: number[]
  reviewed: boolean
}

function groupNewRoutes(rows: UnfiledRow[]): RouteGroup[] {
  const map = new Map<string, RouteGroup>()
  for (const r of rows) {
    const key = `${r.iata_number}|${r.dep_iata}|${r.arr_iata}|${r.sched_dep_utc}`
    if (!map.has(key)) {
      map.set(key, { key, iata_number: r.iata_number, dep_iata: r.dep_iata, arr_iata: r.arr_iata,
        dep_utc: r.sched_dep_utc ?? '', arr_utc: r.sched_arr_utc ?? '',
        duration_min: r.duration_min, days: [], ids: [], reviewed: true })
    }
    const g = map.get(key)!
    if (r.day_of_week && !g.days.includes(r.day_of_week)) g.days.push(r.day_of_week)
    g.ids.push(r.id)
    if (!r.reviewed) g.reviewed = false
  }
  return Array.from(map.values())
}

const DOW_ORDER_ALL = ['mon','tue','wed','thu','fri','sat','sun']

export default function ReconcilePage() {
  const [rows, setRows]           = useState<UnfiledRow[]>([])
  const [loading, setLoading]     = useState(true)
  const [tab, setTab]             = useState<'time_drift' | 'new_route'>('time_drift')
  const [hideReviewed, setHide]   = useState(true)
  const [saving, setSaving]       = useState<number | null>(null)
  const [deleting, setDeleting]   = useState<string | null>(null)
  const [sortDir, setSortDir]     = useState<'asc' | 'desc' | null>(null)
  const [inserting, setInserting] = useState<string | null>(null)
  const [insertErr, setInsertErr] = useState<Record<string, string>>({})

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

  /**
   * Airport timezones, for the local-time columns.
   *
   * airportOffset is a module-level object that loadGeoData fills in place, so React has no
   * way to know it changed — hence the counter. Without it the table renders once with the
   * +3 fallback and never corrects itself, which is the bug this was meant to fix.
   */
  /**
   * Yesterday's flights that were scheduled and then did nothing.
   *
   * Read straight from the table rather than through the reconcile feed: it is a different
   * question from a schedule mismatch — not "the timetable is wrong" but "the timetable was
   * right and nothing happened".
   */
  const [idle, setIdle] = useState<IdleRow[] | null>(null)
  useEffect(() => {
    fetch('/api/admin/no-activity')
      .then(r => r.ok ? r.json() : null)
      .then(d => setIdle(d?.rows ?? []))
      .catch(() => setIdle([]))
  }, [])

  const [, setGeoTick] = useState(0)
  useEffect(() => { loadGeoData().then(() => setGeoTick(t => t + 1)).catch(() => {}) }, [])

  /**
   * The response was previously ignored and the row marked reviewed locally regardless — the
   * same fault already fixed for delete below. A rejected update looked like a success until
   * the next refresh brought the row back, which is exactly how this was reported.
   */
  async function markReviewed(id: number) {
    setSaving(id)
    try {
      const res = await fetch('/api/admin/reconcile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, reviewed: true }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || body?.ok === false) {
        window.alert(`Could not apply this change.\n\n${body?.error ?? `HTTP ${res.status}`}\n\n`
                   + `route_master was not modified and the row stays on the list.`)
        return
      }
      setRows(prev => prev.map(r => r.id === id ? { ...r, reviewed: true } : r))
    } catch (e) {
      window.alert(`Could not apply this change: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(null)
    }
  }

  // Delete is permanent and sits immediately beside "+ Add Route". These rows are the only
  // record that a flight was ever flagged, so a mis-click loses the schedule data with them
  // — RJ439/RJ440 (AMM↔DAM) were lost that way and only recovered because the values
  // happened to still be on screen elsewhere. The confirmation lives here rather than at the
  // call sites so a future button cannot skip it.
  async function deleteRows(ids: number[], key: string, label: string) {
    const n = ids.length
    const ok = window.confirm(
      `Delete ${n} unfiled row${n === 1 ? '' : 's'} for ${label}?\n\n`
      + `This is permanent and cannot be undone.\n`
      + `It does NOT file the route — use "+ Add Route" for that.`
    )
    if (!ok) return

    setDeleting(key)
    try {
      const res = await fetch('/api/admin/reconcile', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      // Previously the rows were dropped from local state regardless, so a failed request
      // looked like a successful delete until the next reload.
      if (!res.ok) {
        window.alert(`Delete failed (HTTP ${res.status}). Nothing was removed.`)
        return
      }
      setRows(prev => prev.filter(r => !ids.includes(r.id)))
    } catch (e) {
      window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}. Nothing was removed.`)
    } finally {
      setDeleting(null)
    }
  }

  async function addRoute(g: RouteGroup) {
    setInserting(g.key)
    setInsertErr(prev => { const n = { ...prev }; delete n[g.key]; return n })
    const res = await fetch('/api/admin/insert-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        iata_number: g.iata_number, dep_iata: g.dep_iata, arr_iata: g.arr_iata,
        dep_time_utc: g.dep_utc, arr_time_utc: g.arr_utc,
        duration_min: g.duration_min, days: g.days, unfiled_ids: g.ids,
      }),
    })
    const data = await res.json()
    if (data.ok) {
      setRows(prev => prev.map(r => g.ids.includes(r.id) ? { ...r, reviewed: true } : r))
    } else {
      setInsertErr(prev => ({ ...prev, [g.key]: data.message ?? data.error }))
    }
    setInserting(null)
  }

  const driftRows   = rows.filter(r => r.reason === 'time_drift')
  const newRows     = rows.filter(r => r.reason === 'new_route')
  const displayed   = (tab === 'time_drift' ? driftRows : newRows)
    .filter(r => hideReviewed ? !r.reviewed : true)
    .sort((a, b) => {
      if (!sortDir) return 0
      const cmp = a.iata_number.localeCompare(b.iata_number)
      return sortDir === 'asc' ? cmp : -cmp
    })

  const newGroups = groupNewRoutes(newRows).filter(g => hideReviewed ? !g.reviewed : true)
    .sort((a, b) => {
      if (!sortDir) return 0
      const cmp = a.iata_number.localeCompare(b.iata_number)
      return sortDir === 'asc' ? cmp : -cmp
    })

  const toggleSort = () => setSortDir(d => d === 'asc' ? 'desc' : d === 'desc' ? null : 'asc')

  const pendingDrift = driftRows.filter(r => !r.reviewed).length
  const pendingNew   = newRows.filter(r => !r.reviewed).length

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Schedule Reconciliation</h1>
      <p style={s.sub}>
        Flights from <code>fr24_daily_cache</code> that differ from <code>route_master</code>.
        Review daily before automating any updates.
      </p>

      {/* No activity — scheduled, then nothing */}
      {idle !== null && idle.length > 0 && (
        <div style={{ marginBottom: 22, border: '1px solid #30363d', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '11px 14px', background: '#161b22', borderBottom: '1px solid #30363d' }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Scheduled, no activity</span>
            <span style={{ color: '#8b949e', fontSize: 12, marginLeft: 10 }}>
              {idle.filter(r => !r.resolved_at).length} open · {idle.filter(r => r.resolved_at).length} resolved
            </span>
            <div style={{ color: '#6e7681', fontSize: 11.5, marginTop: 4 }}>
              A flight that never departed and never arrived. Open rows either flew very late or
              did not fly at all; resolved rows turned out to be late.
            </div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <tbody>
              {idle.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid #30363d', opacity: r.resolved_at ? 0.5 : 1 }}>
                  <td style={{ padding: '7px 12px', color: '#8b949e' }}>{r.flight_date}</td>
                  <td style={{ padding: '7px 12px', fontWeight: 700 }}>{r.iata_number}</td>
                  <td style={{ padding: '7px 12px', color: '#8b949e' }}>
                    {r.dep_iata} → {r.arr_iata}
                  </td>
                  <td style={{ padding: '7px 12px', color: '#8b949e' }}>{r.sched_dep_utc ?? '—'} UTC</td>
                  <td style={{ padding: '7px 12px' }}>
                    {r.resolved_at
                      ? <span style={{ color: '#3fb950' }}>flew late</span>
                      : <span style={{ color: '#d29922' }}>+{r.hours_overdue ?? '?'}h no activity</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
          {tab === 'new_route' ? newGroups.length : displayed.length} {tab === 'new_route' ? 'route' : 'row'}{(tab === 'new_route' ? newGroups.length : displayed.length) !== 1 ? 's' : ''}
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
              <th style={{ ...s.th, cursor: 'pointer', userSelect: 'none' }} onClick={toggleSort}>
                Flight {sortDir === 'asc' ? '↑' : sortDir === 'desc' ? '↓' : '↕'}
              </th>
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
                <td style={{ ...s.td, fontFamily: 'monospace', fontWeight: 600, color: '#fff' }}>{r.iata_number}</td>
                <td style={{ ...s.td, color: '#fff' }}>{r.dep_iata} → {r.arr_iata}</td>
                <td style={s.tdDim}>{DOW[r.day_of_week ?? ''] ?? r.day_of_week}</td>
                <td style={{ ...s.td, color: '#2563eb', fontWeight: 600 }}>
                  {localTime(r.sched_dep_utc, r.dep_iata)}
                  <span style={{ color: '#999', fontWeight: 400 }}> ({hhmm(r.sched_dep_utc)} UTC)</span>
                </td>
                <td style={s.tdDim}>
                  {localTime(r.rm_dep_time_utc, r.dep_iata)}
                  <span style={{ color: '#ccc' }}> ({hhmm(r.rm_dep_time_utc)} UTC)</span>
                </td>
                <td style={s.td}>{diffBadge(r.diff_minutes)}</td>
                <td style={{ ...s.td, display: 'flex', gap: 6, alignItems: 'center' }}>
                  {r.reviewed
                    ? <span style={s.btnDone}>✓ Reviewed</span>
                    : <button style={s.btn} disabled={saving === r.id} onClick={() => markReviewed(r.id)}>
                        {saving === r.id ? '…' : 'Mark reviewed'}
                      </button>
                  }
                  <button
                    style={s.btnDel}
                    disabled={deleting === String(r.id)}
                    onClick={() => deleteRows(
                      [r.id],
                      String(r.id),
                      `${r.iata_number}  ${r.dep_iata}→${r.arr_iata}  ${hhmm(r.sched_dep_utc)} UTC${r.day_of_week ? '  ' + (DOW[r.day_of_week] ?? r.day_of_week) : ''}`,
                    )}
                  >
                    {deleting === String(r.id) ? '…' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={{ ...s.th, cursor: 'pointer', userSelect: 'none' }} onClick={toggleSort}>
                Flight {sortDir === 'asc' ? '↑' : sortDir === 'desc' ? '↓' : '↕'}
              </th>
              <th style={s.th}>Route</th>
              <th style={s.th}>Days</th>
              <th style={s.th}>Dep (local)</th>
              <th style={s.th}>Arr (local)</th>
              <th style={s.th}>Duration</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {newGroups.map(g => (
              <React.Fragment key={g.key}>
                <tr style={{ opacity: g.reviewed ? 0.45 : 1 }}>
                  <td style={{ ...s.td, fontFamily: 'monospace', fontWeight: 600, color: '#fff' }}>{g.iata_number}</td>
                  <td style={{ ...s.td, color: '#fff' }}>{g.dep_iata} → {g.arr_iata}</td>
                  <td style={s.td}>
                    <div style={{ display: 'flex', gap: 3 }}>
                      {DOW_ORDER_ALL.map(d => (
                        <span key={d} style={{ width: 22, height: 22, borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, background: g.days.includes(d) ? '#1d4ed8' : '#e5e7eb', color: g.days.includes(d) ? '#fff' : '#9ca3af' }}>
                          {d[0].toUpperCase()}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ ...s.td, color: '#2563eb', fontWeight: 600 }}>{localTime(g.dep_utc, g.dep_iata)}</td>
                  <td style={{ ...s.td, color: '#2563eb', fontWeight: 600 }}>{localTime(g.arr_utc, g.arr_iata)}</td>
                  <td style={s.tdDim}>{g.duration_min ? `${Math.floor(g.duration_min / 60)}h ${g.duration_min % 60}m` : '—'}</td>
                  <td style={{ ...s.td, display: 'flex', gap: 6, alignItems: 'center' }}>
                    {g.reviewed
                      ? <span style={s.btnDone}>✓ Added</span>
                      : <button style={{ ...s.btn, background: '#1d4ed8', color: '#fff', border: 'none', padding: '5px 12px' }}
                          disabled={inserting === g.key} onClick={() => addRoute(g)}>
                          {inserting === g.key ? '…' : '+ Add Route'}
                        </button>
                    }
                    <button
                      style={s.btnDel}
                      disabled={deleting === g.key}
                      onClick={() => deleteRows(
                        g.ids,
                        g.key,
                        `${g.iata_number}  ${g.dep_iata}→${g.arr_iata}  ${hhmm(g.dep_utc)} UTC  ${g.days.map(d => DOW[d] ?? d).join(', ')}`,
                      )}
                    >
                      {deleting === g.key ? '…' : 'Delete'}
                    </button>
                  </td>
                </tr>
                {insertErr[g.key] && (
                  <tr>
                    <td colSpan={7} style={{ padding: '4px 10px 10px', color: '#dc2626', fontSize: 12 }}>
                      ⚠ {insertErr[g.key]}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

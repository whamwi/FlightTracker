'use client'

import { useEffect, useState, useCallback } from 'react'

interface UnfilledRow {
  id: number
  iata_number: string
  broadcast_callsign: string
  dep_iata: string
  arr_iata: string
  dep_time: string | null
  arr_time: string | null
  dep_time_utc: string | null
  arr_time_utc: string | null
  duration_min: number | null
  days_of_week: string[]
  missing: 'dep' | 'arr'
}

interface FilledRow {
  id: number
  iata_number: string
  broadcast_callsign: string
  dep_iata: string
  arr_iata: string
  dep_time: string | null
  arr_time: string | null
  dep_time_utc: string | null
  arr_time_utc: string | null
  duration_min: number | null
  days_of_week: string[]
}

interface EditState {
  flight_iata: string
  dep_iata: string
  arr_iata: string
  dep_time_utc: string
  arr_time_utc: string
  days_of_week: string[]
}

const ALL_DAYS = ['mon','tue','wed','thu','fri','sat','sun']

function fr24Url(iataNumber: string, callsign: string): string {
  const slug = iataNumber.startsWith('XH') ? callsign : iataNumber
  return `https://www.flightradar24.com/data/flights/${slug.toLowerCase()}`
}

const AIRPORT_UTC_OFFSET: Record<string, number> = {
  DXB: 4, AUH: 4, SHJ: 4, MCT: 4, EVN: 4,  // UTC+4
  AMS: 2, MJI: 2,                               // UTC+2
}

function fmtLocal(utc: string | null, iata?: string): string {
  if (!utc) return '—'
  const [h, m] = utc.slice(0, 5).split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return '—'
  const offsetMin = (AIRPORT_UTC_OFFSET[iata ?? ''] ?? 3) * 60
  const local = ((h * 60 + m) + offsetMin) % 1440
  return `${String(Math.floor(local / 60)).padStart(2, '0')}:${String(local % 60).padStart(2, '0')}`
}

function durLabel(dep: string, arr: string): string {
  if (!dep || !arr) return '—'
  const [dh, dm] = dep.slice(0,5).split(':').map(Number)
  const [ah, am] = arr.slice(0,5).split(':').map(Number)
  if (isNaN(dh) || isNaN(ah)) return '—'
  const min = ((ah * 60 + am) - (dh * 60 + dm) + 1440) % 1440
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

type SortDir = 'asc' | 'desc'
interface SortState { col: string; dir: SortDir }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sortRows<T extends Record<string, any>>(rows: T[], sort: SortState | null): T[] {
  if (!sort) return rows
  return [...rows].sort((a, b) => {
    const av = String(a[sort.col] ?? '')
    const bv = String(b[sort.col] ?? '')
    return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
  })
}

export default function AdminRouteCache() {
  const [data, setData]     = useState<{ unfilled: UnfilledRow[]; filled: FilledRow[] } | null>(null)
  const [edit, setEdit]     = useState<EditState | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg]       = useState('')
  const [tab, setTab]       = useState<'unfilled' | 'filled'>('unfilled')
  const [sort, setSort]     = useState<SortState>({ col: 'broadcast_callsign', dir: 'asc' })

  function handleSort(col: string) {
    setSort(s => s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' })
  }

  function SortTh({ col, label }: { col: string; label: string }) {
    const active = sort.col === col
    return (
      <th style={{ ...s.th, cursor: 'pointer', userSelect: 'none', background: active ? '#d6d6d6' : '#eeeeee' }}
          onClick={() => handleSort(col)}>
        {label} {active ? (sort.dir === 'asc' ? '↑' : '↓') : <span style={{ opacity: 0.35 }}>↕</span>}
      </th>
    )
  }

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/route-cache')
    if (res.ok) setData(await res.json())
  }, [])

  useEffect(() => { load() }, [load])

  function openEditFromUnfilled(row: UnfilledRow) {
    setEdit({
      flight_iata:  row.iata_number,
      dep_iata:     row.dep_iata,
      arr_iata:     row.arr_iata,
      dep_time_utc: row.dep_time_utc?.slice(0, 5) ?? '',
      arr_time_utc: row.arr_time_utc?.slice(0, 5) ?? '',
      days_of_week: row.days_of_week ?? [],
    })
  }

  function openEditFromFilled(row: FilledRow) {
    setEdit({
      flight_iata:  row.iata_number,
      dep_iata:     row.dep_iata,
      arr_iata:     row.arr_iata,
      dep_time_utc: row.dep_time_utc?.slice(0, 5) ?? '',
      arr_time_utc: row.arr_time_utc?.slice(0, 5) ?? '',
      days_of_week: row.days_of_week ?? [],
    })
  }

  function toggleDay(d: string) {
    setEdit(p => {
      if (!p) return p
      const already = p.days_of_week.includes(d)
      return { ...p, days_of_week: already ? p.days_of_week.filter(x => x !== d) : [...p.days_of_week, d] }
    })
  }

  async function save() {
    if (!edit) return
    if (!edit.dep_time_utc || !edit.arr_time_utc) { setMsg('Both dep and arr UTC times are required'); return }
    setSaving(true); setMsg('')
    const res = await fetch('/api/admin/route-cache', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(edit),
    })
    const json = await res.json()
    setSaving(false)
    if (res.ok) {
      setMsg(`Saved ✓ — route_master patched (duration: ${json.duration_min} min)`)
      setEdit(null)
      await load()
    } else {
      setMsg('Error: ' + JSON.stringify(json))
    }
  }

  async function triggerFill() {
    setMsg('Running fill…')
    const res = await fetch('/api/sync/damairport/fill')
    const json = await res.json()
    setMsg(`Fill done — adb_filled:${json.adb_filled} skipped:${json.skipped}`)
    await load()
  }

  if (!data) return <div style={s.page}><p style={{ color: '#444' }}>Loading…</p></div>

  const { unfilled, filled } = data

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Route Master</h1>
          <p style={s.sub}>Manually fill or correct dep/arr times in route_master</p>
        </div>
        <button onClick={triggerFill} style={s.fillBtn}>▶ Run Fill Now</button>
      </div>

      {msg && <div style={s.msg}>{msg}</div>}

      <div style={s.stats}>
        <div style={s.stat}><span style={s.statNum}>{unfilled.length}</span><span style={s.statLabel}>Unfilled</span></div>
        <div style={s.stat}><span style={s.statNum}>{filled.length}</span><span style={s.statLabel}>Filled</span></div>
      </div>

      <div style={s.tabs}>
        <button style={{ ...s.tab, ...(tab === 'unfilled' ? s.tabActive : {}) }} onClick={() => setTab('unfilled')}>
          Unfilled ({unfilled.length})
        </button>
        <button style={{ ...s.tab, ...(tab === 'filled' ? s.tabActive : {}) }} onClick={() => setTab('filled')}>
          Filled Routes ({filled.length})
        </button>
      </div>

      {/* ── UNFILLED ── */}
      {tab === 'unfilled' && (
        unfilled.length === 0
          ? <p style={s.empty}>All routes are filled. Nothing left to do.</p>
          : (
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <SortTh col="iata_number"        label="Flight" />
                    <SortTh col="broadcast_callsign" label="Callsign" />
                    <SortTh col="dep_iata"           label="Route" />
                    <th style={s.th}>Known Side</th>
                    <SortTh col="arr_time_utc"       label="Known UTC" />
                    <th style={s.th}>Known Local</th>
                    <th style={s.th}>Days</th>
                    <th style={s.th}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sortRows(unfilled, sort).map(row => {
                    const knownUtc = row.missing === 'dep' ? row.arr_time_utc : row.dep_time_utc
                    return (
                      <tr key={row.id} style={s.tr}>
                        <td style={s.td}>
                          <a href={fr24Url(row.iata_number, row.broadcast_callsign)} target="_blank" rel="noreferrer" style={s.fr24}>
                            {row.iata_number}
                          </a>
                        </td>
                        <td style={{ ...s.td, ...s.callsign }}>{row.broadcast_callsign}</td>
                        <td style={s.td}>{row.dep_iata} → {row.arr_iata}</td>
                        <td style={s.td}>
                          <span style={{ ...s.badge, ...(row.missing === 'dep' ? s.badgeArr : s.badgeDep) }}>
                            {row.missing === 'dep' ? 'ARR known' : 'DEP known'}
                          </span>
                        </td>
                        <td style={{ ...s.td, ...s.mono }}>{knownUtc?.slice(0, 5) ?? '—'}</td>
                        <td style={{ ...s.td, ...s.mono }}>{fmtLocal(knownUtc, row.missing === 'dep' ? row.arr_iata : row.dep_iata)}</td>
                        <td style={s.td}>{(row.days_of_week ?? []).map(d => d.slice(0, 3)).join(' ')}</td>
                        <td style={s.td}>
                          <button onClick={() => openEditFromUnfilled(row)} style={s.editBtn}>Add Times</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
      )}

      {/* ── FILLED ── */}
      {tab === 'filled' && (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <SortTh col="iata_number"        label="Flight" />
                <SortTh col="broadcast_callsign" label="Callsign" />
                <SortTh col="dep_iata"           label="Route" />
                <SortTh col="dep_time_utc"       label="Dep UTC" />
                <SortTh col="arr_time_utc"       label="Arr UTC" />
                <th style={s.th}>Dep Local</th>
                <th style={s.th}>Arr Local</th>
                <SortTh col="duration_min"       label="Duration" />
                <th style={s.th}>Days</th>
                <th style={s.th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {sortRows(filled, sort).map(row => (
                <tr key={row.id} style={s.tr}>
                  <td style={s.td}>
                    <a href={fr24Url(row.iata_number, row.broadcast_callsign)} target="_blank" rel="noreferrer" style={s.fr24}>
                      {row.iata_number}
                    </a>
                  </td>
                  <td style={{ ...s.td, ...s.callsign }}>{row.broadcast_callsign}</td>
                  <td style={s.td}>{row.dep_iata} → {row.arr_iata}</td>
                  <td style={{ ...s.td, ...s.mono }}>{row.dep_time_utc?.slice(0, 5) ?? '—'}</td>
                  <td style={{ ...s.td, ...s.mono }}>{row.arr_time_utc?.slice(0, 5) ?? '—'}</td>
                  <td style={{ ...s.td, ...s.mono }}>{fmtLocal(row.dep_time_utc, row.dep_iata)}</td>
                  <td style={{ ...s.td, ...s.mono }}>{fmtLocal(row.arr_time_utc, row.arr_iata)}</td>
                  <td style={s.td}>{durLabel(row.dep_time_utc ?? '', row.arr_time_utc ?? '')}</td>
                  <td style={s.td}>{(row.days_of_week ?? []).map(d => d.slice(0, 3)).join(' ')}</td>
                  <td style={s.td}>
                    <button onClick={() => openEditFromFilled(row)} style={s.editBtn}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── EDIT MODAL ── */}
      {edit && (
        <div style={s.overlay} onClick={() => setEdit(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <h2 style={s.modalTitle}>{edit.flight_iata} — {edit.dep_iata} → {edit.arr_iata}</h2>
            <p style={s.modalSub}>Enter scheduled UTC times (HH:MM). Local shows origin/destination airport time.</p>

            {/* Times — stacked to prevent overflow */}
            <div style={s.field}>
              <label style={s.label}>Departure UTC (HH:MM)</label>
              <input
                style={s.input}
                type="text"
                placeholder="e.g. 07:00"
                value={edit.dep_time_utc}
                onChange={e => setEdit(p => p ? { ...p, dep_time_utc: e.target.value } : p)}
              />
              {edit.dep_time_utc && <span style={s.hint}>Local ({edit.dep_iata}): {fmtLocal(edit.dep_time_utc, edit.dep_iata)}</span>}
            </div>

            <div style={{ ...s.field, marginTop: 12 }}>
              <label style={s.label}>Arrival UTC (HH:MM)</label>
              <input
                style={s.input}
                type="text"
                placeholder="e.g. 09:45"
                value={edit.arr_time_utc}
                onChange={e => setEdit(p => p ? { ...p, arr_time_utc: e.target.value } : p)}
              />
              {edit.arr_time_utc && <span style={s.hint}>Local ({edit.arr_iata}): {fmtLocal(edit.arr_time_utc, edit.arr_iata)}</span>}
            </div>

            {edit.dep_time_utc && edit.arr_time_utc && (
              <p style={s.durPreview}>Duration: {durLabel(edit.dep_time_utc, edit.arr_time_utc)}</p>
            )}

            {/* Days of week */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ ...s.label, display: 'block', marginBottom: 8 }}>Days of week</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {ALL_DAYS.map(d => {
                  const active = edit.days_of_week.includes(d)
                  return (
                    <button
                      key={d}
                      onClick={() => toggleDay(d)}
                      style={{ ...s.dayBtn, ...(active ? s.dayBtnActive : {}) }}
                    >
                      {d}
                    </button>
                  )
                })}
              </div>
            </div>

            <div style={s.modalActions}>
              <button onClick={() => setEdit(null)} style={s.cancelBtn}>Cancel</button>
              <button onClick={save} style={s.saveBtn} disabled={saving}>
                {saving ? 'Saving…' : 'Save & Patch Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page:         { fontFamily: 'system-ui, sans-serif', maxWidth: 1300, margin: '0 auto', padding: '24px 20px', color: '#1a1a1a', background: '#ffffff', minHeight: '100vh' },
  header:       { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  title:        { margin: 0, fontSize: 24, fontWeight: 700, color: '#111' },
  sub:          { margin: '4px 0 0', color: '#555', fontSize: 14 },
  msg:          { background: '#e0f2fe', border: '1px solid #7dd3fc', borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 14, color: '#0c4a6e' },
  stats:        { display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' },
  stat:         { background: '#f0f0f0', borderRadius: 8, padding: '12px 18px', minWidth: 110, display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid #ddd' },
  statNum:      { fontSize: 26, fontWeight: 700, lineHeight: 1, color: '#111' },
  statLabel:    { fontSize: 11, color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em' },
  tabs:         { display: 'flex', gap: 4, borderBottom: '2px solid #ddd', marginBottom: 20 },
  tab:          { padding: '8px 18px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, color: '#444', borderBottom: '2px solid transparent', marginBottom: -2 },
  tabActive:    { color: '#0070f3', borderBottomColor: '#0070f3', fontWeight: 700 },
  tableWrap:    { overflowX: 'auto', background: '#fff' },
  table:        { width: '100%', borderCollapse: 'collapse', fontSize: 14, color: '#1a1a1a' },
  th:           { padding: '8px 12px', textAlign: 'left', background: '#eeeeee', color: '#333', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap', borderBottom: '2px solid #ccc' },
  tr:           { borderBottom: '1px solid #e5e5e5', background: '#fff' },
  td:           { padding: '9px 12px', verticalAlign: 'middle', color: '#1a1a1a' },
  mono:         { fontFamily: 'monospace', fontSize: 13, color: '#222' },
  callsign:     { fontFamily: 'monospace', fontSize: 13, color: '#0070f3', fontWeight: 700 },
  badge:        { padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600 },
  badgeArr:     { background: '#dbeafe', color: '#1e40af' },
  badgeDep:     { background: '#fef3c7', color: '#78350f' },
  empty:        { color: '#555', fontStyle: 'italic', padding: '20px 0', fontSize: 15 },
  fr24:         { fontWeight: 700, color: '#0070f3', textDecoration: 'none', fontFamily: 'monospace', fontSize: 13 },
  editBtn:      { padding: '4px 12px', fontSize: 13, border: '1px solid #0070f3', background: '#fff', color: '#0070f3', borderRadius: 5, cursor: 'pointer', fontWeight: 600 },
  fillBtn:      { padding: '8px 18px', background: '#0070f3', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: 14 },
  overlay:      { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '20px' },
  modal:        { background: '#ffffff', borderRadius: 12, padding: 28, width: '100%', maxWidth: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', color: '#1a1a1a', boxSizing: 'border-box' },
  modalTitle:   { margin: '0 0 4px', fontSize: 20, fontWeight: 700, color: '#111' },
  modalSub:     { margin: '0 0 20px', color: '#555', fontSize: 13 },
  field:        { display: 'flex', flexDirection: 'column', gap: 6 },
  label:        { fontSize: 13, fontWeight: 700, color: '#333' },
  input:        { padding: '8px 10px', border: '2px solid #ccc', borderRadius: 6, fontSize: 15, fontFamily: 'monospace', outline: 'none', color: '#111', background: '#fff', width: '100%', boxSizing: 'border-box' },
  hint:         { fontSize: 12, color: '#0070f3', fontWeight: 600 },
  durPreview:   { fontSize: 14, color: '#333', margin: '12px 0 16px', background: '#f0f0f0', padding: '8px 12px', borderRadius: 6 },
  dayBtn:       { padding: '5px 10px', border: '1px solid #ccc', background: '#f5f5f5', color: '#444', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600, textTransform: 'capitalize' },
  dayBtnActive: { background: '#0070f3', color: '#fff', border: '1px solid #0070f3' },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
  cancelBtn:    { padding: '8px 18px', border: '1px solid #999', background: '#f5f5f5', color: '#333', borderRadius: 6, cursor: 'pointer', fontSize: 14 },
  saveBtn:      { padding: '8px 18px', background: '#0070f3', color: '#ffffff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 700 },
}

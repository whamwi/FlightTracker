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
  id:           number | null   // null = insert new rotation
  flight_iata:  string
  dep_iata:     string
  arr_iata:     string
  dep_time_utc: string
  arr_time_utc: string
  days_of_week: string[]
  // rotation-mode (id === null): per-day time entries
  dayTimes:    Record<string, { dep: string; arr: string }>
  activeDay:   string | null
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
      id:           row.id,
      flight_iata:  row.iata_number,
      dep_iata:     row.dep_iata,
      arr_iata:     row.arr_iata,
      dep_time_utc: row.dep_time_utc?.slice(0, 5) ?? '',
      arr_time_utc: row.arr_time_utc?.slice(0, 5) ?? '',
      days_of_week: row.days_of_week ?? [],
      dayTimes: {}, activeDay: null,
    })
  }

  function openEditFromFilled(row: FilledRow) {
    setEdit({
      id:           row.id,
      flight_iata:  row.iata_number,
      dep_iata:     row.dep_iata,
      arr_iata:     row.arr_iata,
      dep_time_utc: row.dep_time_utc?.slice(0, 5) ?? '',
      arr_time_utc: row.arr_time_utc?.slice(0, 5) ?? '',
      days_of_week: row.days_of_week ?? [],
      dayTimes: {}, activeDay: null,
    })
  }

  function addRotation(row: FilledRow) {
    setEdit({
      id:           null,
      flight_iata:  row.iata_number,
      dep_iata:     row.dep_iata,
      arr_iata:     row.arr_iata,
      dep_time_utc: '',
      arr_time_utc: '',
      days_of_week: [],
      dayTimes: {}, activeDay: null,
    })
  }

  function toggleDay(d: string) {
    setEdit(p => {
      if (!p) return p
      // rotation mode: clicking a day sets it as the active day being edited;
      // also flush any already-typed times from the previous active day into dayTimes
      if (p.id === null) {
        const prevDay = p.activeDay
        let updatedDayTimes = p.dayTimes
        if (prevDay && p.dep_time_utc && p.arr_time_utc) {
          updatedDayTimes = { ...updatedDayTimes, [prevDay]: { dep: p.dep_time_utc, arr: p.arr_time_utc } }
        }
        return {
          ...p,
          activeDay:    d,
          dep_time_utc: updatedDayTimes[d]?.dep ?? p.dep_time_utc,
          arr_time_utc: updatedDayTimes[d]?.arr ?? p.arr_time_utc,
          dayTimes:     updatedDayTimes,
          days_of_week: Object.keys(updatedDayTimes).filter(k => updatedDayTimes[k].dep && updatedDayTimes[k].arr),
        }
      }
      const already = p.days_of_week.includes(d)
      return { ...p, days_of_week: already ? p.days_of_week.filter(x => x !== d) : [...p.days_of_week, d] }
    })
  }

  // In rotation mode: commit times for the active day whenever dep/arr change
  function setRotationTime(field: 'dep' | 'arr', val: string) {
    setEdit(p => {
      if (!p || p.id !== null || !p.activeDay) return p
      const day = p.activeDay
      const prev = p.dayTimes[day] ?? { dep: '', arr: '' }
      const updated = { ...prev, [field]: val }
      const newDayTimes = { ...p.dayTimes, [day]: updated }
      return {
        ...p,
        dep_time_utc: field === 'dep' ? val : p.dep_time_utc,
        arr_time_utc: field === 'arr' ? val : p.arr_time_utc,
        dayTimes: newDayTimes,
        days_of_week: Object.keys(newDayTimes).filter(k => newDayTimes[k].dep && newDayTimes[k].arr),
      }
    })
  }

  async function save() {
    if (!edit) return
    setSaving(true); setMsg('')
    try {
      // rotation mode: flush current field values into dayTimes first, then group by (dep, arr)
      if (edit.id === null) {
        // commit any typed-but-not-yet-stored times for the active day
        let dayTimes = edit.dayTimes
        if (edit.activeDay && edit.dep_time_utc && edit.arr_time_utc) {
          dayTimes = { ...dayTimes, [edit.activeDay]: { dep: edit.dep_time_utc, arr: edit.arr_time_utc } }
        }

        const entries = Object.entries(dayTimes).filter(([, t]) => t.dep && t.arr)
        if (entries.length === 0) { setMsg('Enter times for at least one day'); setSaving(false); return }

        const groups = new Map<string, { dep: string; arr: string; days: string[] }>()
        for (const [day, t] of entries) {
          const key = `${t.dep}|${t.arr}`
          if (!groups.has(key)) groups.set(key, { dep: t.dep, arr: t.arr, days: [] })
          groups.get(key)!.days.push(day)
        }

        const results: string[] = []
        for (const g of groups.values()) {
          const res = await fetch('/api/admin/route-cache', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              flight_iata:  edit.flight_iata,
              dep_iata:     edit.dep_iata,
              arr_iata:     edit.arr_iata,
              dep_time_utc: g.dep,
              arr_time_utc: g.arr,
              days_of_week: g.days,
            }),
          })
          const text = await res.text()
          const json = text ? JSON.parse(text) : {}
          if (!res.ok) { setMsg('Error: ' + JSON.stringify(json)); setSaving(false); return }
          results.push(`[${g.days.join('/')}] dep=${g.dep} arr=${g.arr} — ${json.duration_min} min`)
        }
        setSaving(false)
        setMsg(`Saved ✓ — ${results.join(' · ')}`)
        setEdit(null)
        await load()
        return
      }

      // edit mode: single row patch
      if (!edit.dep_time_utc || !edit.arr_time_utc) { setMsg('Both dep and arr UTC times are required'); setSaving(false); return }
      const res = await fetch('/api/admin/route-cache', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...edit, id: edit.id }),
      })
      const text = await res.text()
      const json = text ? JSON.parse(text) : {}
      setSaving(false)
      if (res.ok) {
        setMsg(`Saved ✓ — ${json.action} (duration: ${json.duration_min} min)`)
        setEdit(null)
        await load()
      } else {
        setMsg('Error: ' + JSON.stringify(json))
      }
    } catch (e) {
      setMsg('Error: ' + String(e))
      setSaving(false)
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
      <div style={s.stickyTop}>
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
      {tab === 'filled' && (() => {
        const sortedFilled = sortRows(filled, sort)

        // Count how many rows each flight has, and assign a shade index to multi-row flights
        const flightCount: Record<string, number> = {}
        for (const r of sortedFilled) flightCount[r.iata_number] = (flightCount[r.iata_number] ?? 0) + 1

        // Walk in sorted order to assign alternating shade bands
        const flightShade: Record<string, number> = {}
        let shadeIdx = 0
        for (const r of sortedFilled) {
          if (flightCount[r.iata_number] > 1 && !(r.iata_number in flightShade)) {
            flightShade[r.iata_number] = shadeIdx++
          }
        }

        return (
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
                {sortedFilled.map(row => {
                  const shade = flightShade[row.iata_number]
                  const bg = shade === undefined
                    ? '#ffffff'
                    : shade % 2 === 0 ? '#f0f4ff' : '#f0fff4'
                  return (
                    <tr key={row.id} style={{ ...s.tr, background: bg }}>
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
                        {' '}
                        <button onClick={() => addRotation(row)} style={s.rotBtn}>+ Rotation</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })()}

      {/* ── EDIT / ROTATION MODAL ── */}
      {edit && (() => {
        const isRotation = edit.id === null

        // For rotation mode: detect if all entered days share the same time
        const filledDays = isRotation
          ? Object.entries(edit.dayTimes).filter(([, t]) => t.dep && t.arr)
          : []
        const allSame = filledDays.length > 1 && filledDays.every(
          ([, t]) => t.dep === filledDays[0][1].dep && t.arr === filledDays[0][1].arr
        )

        // Unique time groups for summary
        const groups = new Map<string, string[]>()
        for (const [day, t] of filledDays) {
          const key = t.dep && t.arr ? `${t.dep} → ${t.arr}` : ''
          if (!key) continue
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key)!.push(day)
        }

        return (
          <div style={s.overlay} onClick={() => setEdit(null)}>
            <div style={s.modal} onClick={e => e.stopPropagation()}>
              <h2 style={s.modalTitle}>{edit.flight_iata} — {edit.dep_iata} → {edit.arr_iata}</h2>
              <p style={s.modalSub}>
                {edit.id ? `Editing rotation #${edit.id}` : 'New rotation'} · UTC times (HH:MM) · local = airport time
              </p>

              {isRotation ? (
                /* ── PER-DAY ROTATION FLOW ── */
                <>
                  {/* Day picker — click to select day being edited */}
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ ...s.label, display: 'block', marginBottom: 8 }}>
                      Click a day to enter its times
                    </label>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {ALL_DAYS.map(d => {
                        const t = edit.dayTimes[d]
                        const filled = !!(t?.dep && t?.arr)
                        const isActive = edit.activeDay === d
                        const sameAsFirst = allSame && filled
                        return (
                          <button
                            key={d}
                            onClick={() => toggleDay(d)}
                            style={{
                              ...s.dayBtn,
                              ...(isActive ? s.dayBtnActive : {}),
                              ...(filled && !isActive ? (sameAsFirst ? s.dayBtnSame : s.dayBtnFilled) : {}),
                              position: 'relative',
                            }}
                          >
                            {d}
                            {filled && !isActive && (
                              <span style={s.dayDot} />
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Time inputs for the active day */}
                  {edit.activeDay && (
                    <div style={{ background: '#f8f8f8', borderRadius: 8, padding: '14px 14px 10px', marginBottom: 14, border: '1px solid #e0e0e0' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: '#444', marginBottom: 10, textTransform: 'capitalize' }}>
                        {edit.activeDay}
                      </div>
                      <div style={s.field}>
                        <label style={s.label}>Departure UTC</label>
                        <input
                          style={s.input}
                          type="text"
                          placeholder="e.g. 07:00"
                          value={edit.dep_time_utc}
                          onChange={e => setRotationTime('dep', e.target.value)}
                          autoFocus
                        />
                        {edit.dep_time_utc && (
                          <span style={s.hint}>Local ({edit.dep_iata}): {fmtLocal(edit.dep_time_utc, edit.dep_iata)}</span>
                        )}
                      </div>
                      <div style={{ ...s.field, marginTop: 10 }}>
                        <label style={s.label}>Arrival UTC</label>
                        <input
                          style={s.input}
                          type="text"
                          placeholder="e.g. 09:45"
                          value={edit.arr_time_utc}
                          onChange={e => setRotationTime('arr', e.target.value)}
                        />
                        {edit.arr_time_utc && (
                          <span style={s.hint}>Local ({edit.arr_iata}): {fmtLocal(edit.arr_time_utc, edit.arr_iata)}</span>
                        )}
                      </div>
                      {edit.dep_time_utc && edit.arr_time_utc && (
                        <p style={{ ...s.durPreview, margin: '10px 0 0' }}>
                          Duration: {durLabel(edit.dep_time_utc, edit.arr_time_utc)}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Summary of groups */}
                  {groups.size > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      {allSame && (
                        <div style={s.sameTimeBanner}>
                          All {filledDays.length} days share the same time — will create 1 rotation
                        </div>
                      )}
                      {!allSame && groups.size > 0 && (
                        <div style={{ fontSize: 12, color: '#555', lineHeight: 1.6 }}>
                          {Array.from(groups.entries()).map(([times, days]) => (
                            <div key={times}>
                              <span style={{ fontFamily: 'monospace', color: '#111' }}>{times}</span>
                              {' → '}
                              <span style={{ color: '#0070f3', fontWeight: 600 }}>{days.join(', ')}</span>
                            </div>
                          ))}
                          <div style={{ color: '#888', marginTop: 4 }}>
                            Will create {groups.size} rotation{groups.size > 1 ? 's' : ''}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                /* ── STANDARD EDIT FLOW ── */
                <>
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
                </>
              )}

              <div style={s.modalActions}>
                <button onClick={() => setEdit(null)} style={s.cancelBtn}>Cancel</button>
                <button onClick={save} style={s.saveBtn} disabled={saving}>
                  {saving ? 'Saving…' : edit.id ? 'Save & Patch' : `Insert Rotation${groups.size > 1 ? 's' : ''}`}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page:         { fontFamily: 'system-ui, sans-serif', maxWidth: 1300, margin: '0 auto', padding: '0 20px 24px', color: '#1a1a1a', background: '#ffffff', minHeight: '100vh' },
  stickyTop:    { position: 'sticky', top: 0, zIndex: 10, background: '#ffffff', paddingTop: 24, paddingBottom: 2, borderBottom: '1px solid #e5e5e5' },
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
  rotBtn:       { padding: '4px 10px', fontSize: 12, border: '1px solid #16a34a', background: '#f0fdf4', color: '#16a34a', borderRadius: 5, cursor: 'pointer', fontWeight: 600 },
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
  dayBtn:        { padding: '5px 10px', border: '1px solid #ccc', background: '#f5f5f5', color: '#444', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600, textTransform: 'capitalize' },
  dayBtnActive:  { background: '#0070f3', color: '#fff', border: '1px solid #0070f3' },
  dayBtnFilled:  { background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' },
  dayBtnSame:    { background: '#bbf7d0', color: '#14532d', border: '1px solid #4ade80' },
  dayDot:        { position: 'absolute', top: 3, right: 3, width: 5, height: 5, borderRadius: '50%', background: '#16a34a' } as React.CSSProperties,
  sameTimeBanner: { background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#15803d', fontWeight: 600, marginBottom: 8 },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
  cancelBtn:    { padding: '8px 18px', border: '1px solid #999', background: '#f5f5f5', color: '#333', borderRadius: 6, cursor: 'pointer', fontSize: 14 },
  saveBtn:      { padding: '8px 18px', background: '#0070f3', color: '#ffffff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 700 },
}

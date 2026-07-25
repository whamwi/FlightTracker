'use client'

import { useState, useEffect, useCallback } from 'react'

const TZ = 'Asia/Damascus'

function fmtTime(unix: number | null): string {
  if (!unix) return '—'
  return new Date(unix * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ })
}

function fmtDate(unix: number | null): string {
  if (!unix) return ''
  return new Date(unix * 1000).toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ })
}

function diffMin(sched: number | null, actual: number | null): number | null {
  if (!sched || !actual) return null
  return Math.round((actual - sched) / 60)
}

// Aircraft registration → flight number override for flights FR24 widget doesn't carry a number for.
const REG_TO_FLIGHT: Record<string, string> = {
  'YK-BAA': 'FYC728',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// Returns flights bucketed by their actual operating date in Syria time.
// Departures are keyed by sched_dep, arrivals by sched_arr — so overnight
// flights (depart Jul 24, arrive DAM Jul 25) land in the correct date bucket,
// and next-day flights visible in the widget are saved to their own date.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeForCache(data: any): Record<string, { arrivals: object[]; departures: object[] }> {
  const sched = data?.result?.response?.airport?.pluginData?.schedule ?? {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normFlight = (f: any, dir: 'arrivals' | 'departures') => {
    const fl = f?.flight
    if (!fl) return null
    const reg      = fl.aircraft?.registration ?? null
    const num      = fl.identification?.number?.default ?? fl.identification?.callsign ?? (reg ? REG_TO_FLIGHT[reg] : null) ?? reg ?? null
    const schedDep = fl.time?.scheduled?.departure ?? null
    const schedArr = fl.time?.scheduled?.arrival   ?? null
    // For completed/landed flights FR24 may omit the origin-side scheduled time.
    // Only require the time relevant to the direction we're processing.
    if (dir === 'arrivals'   && !schedArr) return null
    if (dir === 'departures' && !schedDep) return null
    // fl.flight_time is in seconds; convert to minutes for the fallback case
    const durationMin = (schedDep && schedArr)
      ? Math.round((schedArr - schedDep) / 60)
      : Math.round((fl.flight_time ?? 0) / 60)
    const flight = {
      num,
      airline:      fl.airline?.name ?? null,
      airline_iata: fl.airline?.code?.iata ?? null,
      dep_iata:     fl.airport?.origin?.code?.iata ?? null,
      arr_iata:     fl.airport?.destination?.code?.iata ?? null,
      sched_dep:    schedDep,
      sched_arr:    schedArr,
      duration_min: durationMin,
      status:       fl.status?.text ?? null,
      est_dep:      fl.time?.estimated?.departure ?? null,
      est_arr:      fl.time?.estimated?.arrival   ?? null,
      real_dep:     fl.time?.real?.departure      ?? null,
      real_arr:     fl.time?.real?.arrival        ?? null,
    }
    // Drop FR24 widget artifacts: corrupted entries have an inflated block time
    // (> 5 hours for any Syrian-region route is always a bad sched_arr timestamp).
    if (durationMin > 300) return null
    return flight
  }

  const statusPriority = (s: string | null): number => {
    const t = (s ?? '').toLowerCase()
    if (t.includes('landed') || t.includes('arrived')) return 8
    if (t.includes('approach'))                         return 7
    if (t.includes('en route') || t.includes('in flight')) return 6
    if (t.includes('departed') || t.includes('took off')) return 5
    if (t.startsWith('delayed'))                        return 4
    if (t.startsWith('estimated') || t.startsWith('expect')) return 3
    if (t === 'scheduled' || t === 'scheduled*')        return 1
    return 0
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byDate: Record<string, { arrivals: any[]; departures: any[] }> = {}
  const bucket = (date: string) => {
    if (!byDate[date]) byDate[date] = { arrivals: [], departures: [] }
    return byDate[date]
  }

  // Upsert a flight into a list by (num|dep_iata|arr_iata) key.
  // When FR24 shows two entries for the same flight (e.g. "Scheduled*" + "Landed HH:MM"),
  // keep only the one with the higher-priority status so the cache stays deduplicated.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upsert = (list: any[], flight: any, keyFields: string[]) => {
    const key = keyFields.map(k => flight[k] ?? '').join('|')
    const idx = list.findIndex(e => keyFields.map(k => e[k] ?? '').join('|') === key)
    if (idx >= 0) {
      if (statusPriority(flight.status) > statusPriority(list[idx].status)) {
        list[idx] = flight
      }
    } else {
      list.push(flight)
    }
  }

  for (const f of (sched.departures?.data ?? [])) {
    const flight = normFlight(f, 'departures')
    if (!flight) continue
    const date = new Date(flight.sched_dep! * 1000).toLocaleDateString('en-CA', { timeZone: TZ })
    // For departures: key by destination (origin is always this airport).
    upsert(bucket(date).departures, flight, ['num', 'dep_iata', 'arr_iata'])
  }
  for (const f of (sched.arrivals?.data ?? [])) {
    const flight = normFlight(f, 'arrivals')
    if (!flight) continue
    const date = new Date(flight.sched_arr! * 1000).toLocaleDateString('en-CA', { timeZone: TZ })
    // For arrivals: key by origin only — FR24 clears arr_iata on landed entries
    // so Scheduled* (arr_iata="DAM") and Landed (arr_iata=null) share the same key.
    upsert(bucket(date).arrivals, flight, ['num', 'dep_iata'])
  }

  return byDate
}

function statusClass(text: string): string {
  const t = (text || '').toLowerCase()
  if (t === 'scheduled') return 'text-gray-500'
  if (t.startsWith('estimated')) return 'text-yellow-400'
  if (t.includes('departed') || t.includes('took off')) return 'text-blue-400'
  if (t.includes('en route') || t.includes('in flight')) return 'text-orange-400'
  if (t.includes('landed') || t.includes('arrived')) return 'text-green-400'
  if (t.includes('cancel')) return 'text-red-400'
  return 'text-gray-400'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseFlights(data: any, dir: 'arrivals' | 'departures') {
  const rows = data?.result?.response?.airport?.pluginData?.schedule?.[dir]?.data ?? []
  const total = data?.result?.response?.airport?.pluginData?.schedule?.[dir]?.item?.total ?? 0
  const isArr = dir === 'arrivals'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flights = rows.map((f: any) => {
    const fl = f.flight
    return {
      num:       fl.identification?.number?.default ?? '—',
      callsign:  fl.identification?.callsign ?? null,
      airline:   fl.airline?.name ?? '—',
      iata:      isArr ? fl.airport?.origin?.code?.iata : fl.airport?.destination?.code?.iata,
      schedTime: isArr ? fl.time?.scheduled?.arrival   : fl.time?.scheduled?.departure,
      realTime:  isArr ? fl.time?.real?.arrival        : fl.time?.real?.departure,
      estTime:   isArr ? fl.time?.estimated?.arrival   : fl.time?.estimated?.departure,
      status:    fl.status?.text ?? 'Unknown',
      aircraft:  fl.aircraft?.model?.code ?? null,
      reg:       fl.aircraft?.registration || null,
    }
  })

  // Group by date
  const byDate: Record<string, typeof flights> = {}
  for (const f of flights) {
    const d = fmtDate(f.schedTime) || 'Unknown date'
    if (!byDate[d]) byDate[d] = []
    byDate[d].push(f)
  }

  return { byDate, total }
}

const AIRPORTS = ['DAM', 'ALP', 'LTK']
const DIRS = ['arrivals', 'departures'] as const

export default function Fr24DumpPage() {
  const [airport, setAirport] = useState('DAM')
  const [dir, setDir] = useState<'arrivals' | 'departures'>('arrivals')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [cache, setCache] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const load = useCallback(async (ap: string, force = false) => {
    if (!force && cache[ap]) return
    setLoading(true)
    setError(null)
    setSaved(null)
    try {
      const now = new Date()
      const flightDate = now.toLocaleDateString('en-CA', { timeZone: TZ })  // YYYY-MM-DD
      const damMidnight = new Date(flightDate + 'T00:00:00+03:00')
      const ts = Math.floor(damMidnight.getTime() / 1000)
      const url = `https://api.flightradar24.com/common/v1/airport.json?code=${ap}&plugin=&plugin-setting[schedule][mode]=&plugin-setting[schedule][timestamp]=${ts}&page=1&limit=100&fleet=&token=`
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setCache(prev => ({ ...prev, [ap]: data }))
      setUpdatedAt(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))

      // Write-through: persist to DB bucketed by actual flight date.
      // One POST per date — covers overnight flights and next-day scheduled entries.
      const byDate = normalizeForCache(data)
      const dates = Object.keys(byDate)
      Promise.all(dates.map(date =>
        fetch('/api/fr24-cache', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            airport_iata: ap,
            flight_date:  date,
            arrivals:     byDate[date].arrivals,
            departures:   byDate[date].departures,
          }),
        }).then(r => r.json())
      )).then(results => {
        const saved = results.filter(j => j.ok)
        if (saved.length) setSaved(`Saved ${dates.join(', ')}`)
      }).catch(() => {/* silent */})
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [cache])

  useEffect(() => { load(airport) }, [airport, load])

  const data = cache[airport]
  const { byDate, total } = data ? parseFlights(data, dir) : { byDate: {}, total: 0 }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 text-sm">
      {/* Toolbar */}
      <div className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-2 flex items-center gap-3 flex-wrap">
        <span className="text-xs text-gray-500 uppercase tracking-widest">Airport</span>
        <div className="flex gap-1">
          {AIRPORTS.map(ap => (
            <button
              key={ap}
              onClick={() => { setAirport(ap); load(ap) }}
              className={`px-3 py-1 rounded text-xs font-semibold border transition-colors ${
                airport === ap
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'border-gray-700 text-gray-400 hover:border-blue-500 hover:text-blue-400'
              }`}
            >{ap}</button>
          ))}
        </div>

        <span className="text-xs text-gray-500 uppercase tracking-widest ml-2">View</span>
        <div className="flex gap-1">
          {DIRS.map(d => (
            <button
              key={d}
              onClick={() => setDir(d)}
              className={`px-3 py-1 rounded text-xs font-semibold border transition-colors ${
                dir === d
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'border-gray-700 text-gray-400 hover:border-blue-500 hover:text-blue-400'
              }`}
            >{d}</button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3 text-xs text-gray-500">
          {total > 0 && <span>{total} flights</span>}
          {updatedAt && <span>updated {updatedAt}</span>}
          {saved && <span className="text-green-500">✓ {saved}</span>}
          <button
            onClick={() => load(airport, true)}
            className="border border-gray-700 px-2 py-1 rounded hover:border-blue-500 hover:text-blue-400 transition-colors"
          >↺ Refresh</button>
        </div>
      </div>

      {/* Content */}
      {loading && <div className="p-12 text-center text-gray-500">Fetching FR24 for {airport}…</div>}
      {error && <div className="p-6 text-red-400 font-mono text-xs">Error: {error}</div>}

      {!loading && !error && data && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left">
                <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-widest border-b border-gray-800 whitespace-nowrap">Flight</th>
                <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-widest border-b border-gray-800 whitespace-nowrap">Airline</th>
                <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-widest border-b border-gray-800">{dir === 'arrivals' ? 'From' : 'To'}</th>
                <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-widest border-b border-gray-800">Scheduled</th>
                <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-widest border-b border-gray-800">Estimated</th>
                <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-widest border-b border-gray-800">Actual</th>
                <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-widest border-b border-gray-800">Status</th>
                <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-widest border-b border-gray-800">A/C</th>
                <th className="px-3 py-2 text-xs text-gray-500 uppercase tracking-widest border-b border-gray-800">Reg</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(byDate).map(([date, flights]) => (
                <>
                  <tr key={date + '-sep'}>
                    <td colSpan={9} className="px-3 py-1 text-xs font-bold text-blue-400 uppercase tracking-widest bg-gray-950 border-b border-gray-800">
                      {date}
                    </td>
                  </tr>
                  {(flights as typeof flights).map((f: typeof flights[0], i: number) => {
                    const diff = diffMin(f.schedTime, f.realTime ?? f.estTime)
                    return (
                      <tr key={i} className="hover:bg-gray-900 border-b border-gray-800/50">
                        <td className="px-3 py-1.5 font-mono font-semibold text-white whitespace-nowrap">{f.num}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap">{f.airline}</td>
                        <td className="px-3 py-1.5 font-mono text-xs text-gray-400">{f.iata ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono tabular-nums">{fmtTime(f.schedTime)}</td>
                        <td className="px-3 py-1.5 font-mono tabular-nums text-yellow-400">
                          {f.estTime ? fmtTime(f.estTime) : '—'}
                        </td>
                        <td className="px-3 py-1.5 font-mono tabular-nums text-green-400">
                          {f.realTime ? (
                            <span>
                              {fmtTime(f.realTime)}
                              {diff !== null && diff !== 0 && (
                                <span className={`ml-1 text-xs ${diff > 0 ? 'text-red-400' : 'text-green-300'}`}>
                                  {diff > 0 ? '+' : ''}{diff}m
                                </span>
                              )}
                            </span>
                          ) : '—'}
                        </td>
                        <td className={`px-3 py-1.5 text-xs font-semibold whitespace-nowrap ${statusClass(f.status)}`}>
                          {f.status}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-xs text-gray-500">{f.aircraft ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono text-xs text-gray-500">{f.reg ?? '—'}</td>
                      </tr>
                    )
                  })}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

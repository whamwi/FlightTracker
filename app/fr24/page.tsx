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

// Latakia has no scheduled service; Deir ez-Zor opened 5 Aug 2026 and does. This page exists
// to warm a board by hand, so it should list the airports that actually have one to warm.
/*
 * The tabs this page offers, not the full set that gets harvested.
 *
 * The board already warms every airport that has a flight into Syria — it reads the origin of
 * each arrival and fetches that too, which is where the other twenty in fr24_daily_cache come
 * from. These are the ones worth being able to pull by hand.
 *
 * AUH and KWI are here because the outstations are the half of every flight the Syrian boards
 * cannot see, and a manual refresh is the only way to force one now that the server cannot
 * reach the widget: Cloudflare answers a Vercel function with a challenge page regardless of
 * headers, so this must run in a browser.
 */
const AIRPORTS = ['DAM', 'ALP', 'DEZ', 'AUH', 'KWI']
const DIRS = ['arrivals', 'departures'] as const

export default function Fr24DumpPage() {
  const [airport, setAirport] = useState('DAM')
  const [dir, setDir] = useState<'arrivals' | 'departures'>('arrivals')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [cache, setCache] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  const load = useCallback(async (ap: string, force = false) => {
    if (!force && cache[ap]) return
    setLoading(true)
    setError(null)
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

      /*
       * Read-only as of 15 Aug 2026. This page fetches FR24 and shows it; it no longer writes.
       *
       * It used to persist every load into fr24_daily_cache, bucketed by flight date — the "✓
       * Saved" line under the header. That made the site's board partly a function of who had
       * opened this page and when: the table's freshest row one morning was three hours old and
       * Deir ez-Zor's was fifteen, because nothing else filled it.
       *
       * Every consumer now reads `flight`, kept current by the harvester, so writing here would
       * only feed a table nothing reads. The page keeps its purpose — looking at what FR24 says
       * about an airport right now, which is exactly what it is useful for when the board and the
       * widget disagree.
       */
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

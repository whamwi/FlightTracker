import { NextResponse } from 'next/server'
import { fetchCallsignLookup, fetchIataToIcao, resolveCallsign } from '@/lib/callsign'
import { SYRIA_AIRPORT_SET, SYRIA_AIRPORTS_CSV } from '@/lib/syria-airports'

export const dynamic = 'force-dynamic'

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const PREFIX_TO_IATA: Record<string, string> = { FYC: 'XH', SYR: 'RB', HST: 'RB' }

const SYRIAN_AIRPORTS = SYRIA_AIRPORT_SET

const STATUS_RANK: Record<string, number> = {
  // Terminal, like Arrived — see normaliseStatus in the flightboard route.
  Arrived: 8, Landed: 8, Diverted: 8, Approaching: 7, 'En Route': 6,
  Departed: 5, Cancelled: 5, Delayed: 4, GateClosed: 3, Boarding: 3,
  Expected: 2, Scheduled: 1, Unknown: 0,
}

function unixToUtcHHMM(unix: number | null): string {
  if (!unix) return ''
  const d = new Date(unix * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function normaliseStatus(raw: string | null): string {
  if (!raw) return 'Scheduled'
  const t = raw.toLowerCase()
  if (t === 'scheduled' || t === 'scheduled*')                return 'Scheduled'
  if (t.startsWith('delayed'))                                return 'Delayed'
  if (t.startsWith('estimated') || t.startsWith('expect'))    return 'Expected'
  if (t.includes('boarding'))                                  return 'Boarding'
  if (t.includes('gate close'))                               return 'GateClosed'
  if (t.includes('departed') || t.includes('took off'))       return 'Departed'
  if (t.includes('en route') || t.includes('in flight'))      return 'En Route'
  if (t.includes('approach'))                                  return 'Approaching'
  if (t.includes('landed') || t.includes('arrived'))          return 'Arrived'
  if (t.includes('cancel'))                                    return 'Cancelled'
  return 'Unknown'
}

// Resolve actual times from either ISO-string fields (fr24_actual_*) or unix fields (real_*)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveActualDep(f: any): string | null {
  return f.fr24_actual_dep ?? (f.real_dep ? new Date((f.real_dep as number) * 1000).toISOString() : null)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveActualArr(f: any): string | null {
  return f.fr24_actual_arr ?? (f.real_arr ? new Date((f.real_arr as number) * 1000).toISOString() : null)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveRevisedDep(f: any): string | null {
  return f.fr24_revised_dep ?? (f.est_dep ? new Date((f.est_dep as number) * 1000).toISOString() : null)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveRevisedArr(f: any): string | null {
  return f.fr24_revised_arr ?? (f.est_arr ? new Date((f.est_arr as number) * 1000).toISOString() : null)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function effectiveStatusFor(f: any): { status: string; rank: number } {
  const base       = normaliseStatus(f.status)
  const actualDep  = resolveActualDep(f)
  const actualArr  = resolveActualArr(f)
  const revisedArr = resolveRevisedArr(f)
  const dur = (() => {
    if (actualDep && revisedArr) {
      const d = Math.round((new Date(revisedArr).getTime() - new Date(actualDep).getTime()) / 60_000)
      if (d > 30) return d
    }
    return f.duration_min ?? 0
  })()
  const inferredArrived =
    !actualArr && !!actualDep && dur > 0 &&
    new Date(actualDep).getTime() + dur * 60_000 < Date.now() - 15 * 60_000

  const status = actualArr ? 'Arrived'
    : inferredArrived ? 'Arrived'
    : (actualDep && (STATUS_RANK[base] ?? 0) < STATUS_RANK['Departed'] ? 'Departed' : base)

  return { status, rank: STATUS_RANK[status] ?? 0 }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFlight(f: any, num: string, status: string, airlineMap: Record<string, { name: string; flag: string; icao: string }>, date: string) {
  /*
   * The carrier code, from whichever form the number arrived in.
   *
   * PREFIX_TO_IATA is keyed on three-letter ICAO prefixes — FYC, SYR — which is what FR24
   * publishes for the carriers that use callsigns. Now that XH744 resolves as well as FYC744,
   * `num` can also be the two-character IATA form, and slice(0,3) of XH744 is "XH7", matching
   * nothing. The code came back empty, the logo URL became /airlines/100/_100px.png, and the
   * card showed a black square where Fly Cham's logo should be.
   */
  const airlineIata = f.airline_iata
    || PREFIX_TO_IATA[num.slice(0, 3)]
    || (/^[A-Z][A-Z0-9]\d/.test(num) ? num.slice(0, 2) : '')
    || ''
  const al = airlineMap[airlineIata] ?? { name: f.airline ?? airlineIata, flag: '', icao: '' }
  const actualDep = resolveActualDep(f)
  const revisedArr = resolveRevisedArr(f)
  const dur = (() => {
    if (actualDep && revisedArr) {
      const d = Math.round((new Date(revisedArr).getTime() - new Date(actualDep).getTime()) / 60_000)
      if (d > 30) return d
    }
    return f.duration_min ?? 0
  })()
  return {
    iata_number:     num,
    airline_name:    al.name,
    airline_iata:    airlineIata,
    airline_icao:    al.icao,
    country_flag:    al.flag,
    dep_iata:        f.dep_iata  ?? '',
    arr_iata:        f.arr_iata  ?? '',
    dep_time_utc:    unixToUtcHHMM(f.sched_dep),
    arr_time_utc:    unixToUtcHHMM(f.sched_arr),
    sched_dep_unix:  f.sched_dep  ?? null,
    duration_min:    dur,
    status,
    actual_dep_utc:  resolveActualDep(f),
    actual_arr_utc:  resolveActualArr(f),
    revised_dep_utc: resolveRevisedDep(f),
    revised_arr_utc: resolveRevisedArr(f),
    aircraft_type:   f.aircraft_type ?? f.aircraft ?? null,
    aircraft_reg:    f.aircraft_reg  ?? f.reg     ?? null,
    dep_terminal:    f.dep_terminal     ?? null,
    dep_gate:        f.dep_gate         ?? null,
    arr_terminal:    f.arr_terminal     ?? null,
    arr_gate:        f.arr_gate         ?? null,
    arr_baggage:     f.arr_baggage      ?? null,
    date,
  }
}

async function fetchCaches(date: string): Promise<{ airport_iata: string; arrivals: unknown[]; departures: unknown[] }[]> {
  const res = await fetch(
    `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${date}&airport_iata=in.(${SYRIA_AIRPORTS_CSV})&select=airport_iata,arrivals,departures`,
    { headers: HEADERS }
  )
  if (!res.ok) return []
  return res.json()
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const rawNum = searchParams.get('num')?.trim()
  if (!rawNum) return NextResponse.json({ ok: false, error: 'num required' }, { status: 400 })
  const num = rawNum.replace(/\s+/g, '').toUpperCase()

  /*
   * Every form this flight could be stored under.
   *
   * FR24 publishes some carriers by callsign rather than ticketed number — Fly Cham arrives as
   * FYC744 when the booking, the board card and therefore the share link all say XH744. The
   * board resolves that direction with resolveIata; this route only ever compared the raw
   * string, so /flight/XH744 was "flight not found" in both languages while /flight/FYC744
   * worked. Every Fly Cham share was broken.
   */
  const [lookup, iataToIcao] = await Promise.all([fetchCallsignLookup(), fetchIataToIcao()])
  const aliases = new Set<string>([num])
  const cs = resolveCallsign(num, lookup, iataToIcao)
  if (cs) aliases.add(cs.toUpperCase())
  for (const [k, v] of Object.entries(lookup.toIata)) {
    if (v.toUpperCase() === num) aliases.add(k.toUpperCase())
  }

  const syriaMs = Date.now() + 3 * 3_600_000
  const todayStr = new Date(syriaMs).toISOString().slice(0, 10)
  const reqDate  = searchParams.get('date')
  const dates    = reqDate
    ? [reqDate]
    : [todayStr, new Date(syriaMs - 86_400_000).toISOString().slice(0, 10)]

  const alRes = await fetch(
    `${SB_URL}/rest/v1/airlines?select=iata,icao,name_en,country_flag`,
    { headers: HEADERS, next: { revalidate: 3600 } }
  )
  const airlineMap: Record<string, { name: string; flag: string; icao: string }> = {}
  if (alRes.ok) {
    const rows: { iata: string; icao: string | null; name_en: string; country_flag: string | null }[] = await alRes.json()
    for (const r of rows) airlineMap[r.iata] = { name: r.name_en, flag: r.country_flag ?? '', icao: r.icao ?? '' }
  }

  for (const date of dates) {
    const rows = await fetchCaches(date)
    let bestFlight = null
    let bestRank   = -1
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let bestRaw: any = null
    let bestSide: 'arr' | 'dep' = 'dep'

    for (const row of rows) {
      const airport = row.airport_iata
      const sides: [unknown[], 'arr' | 'dep'][] = [
        [row.arrivals  ?? [], 'arr'],
        [row.departures ?? [], 'dep'],
      ]
      for (const [list, side] of sides) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const raw of list as any[]) {
          const fNum = (raw.num ?? '').replace(/\s+/g, '').toUpperCase()
          if (!aliases.has(fNum)) continue
          // arr_iata / dep_iata are often null in cache — infer from the row's airport
          const f = {
            ...raw,
            arr_iata: raw.arr_iata ?? (side === 'arr' ? airport : null),
            dep_iata: raw.dep_iata ?? (side === 'dep' ? airport : null),
          }
          const { status, rank } = effectiveStatusFor(f)
          if (rank > bestRank) {
            bestFlight = buildFlight(f, num, status, airlineMap, date)
            bestRank   = rank
            bestRaw    = f
            bestSide   = side as 'arr' | 'dep'
          }
        }
      }
    }

    // Second pass: for inbound flights, read origin airport departure cache
    // to get est_dep / est_arr (mirrors what the flightboard does).
    if (bestFlight && bestSide === 'arr' && bestRaw) {
      const originIata = bestRaw.dep_iata as string | null
      if (originIata && !SYRIAN_AIRPORTS.has(originIata)) {
        const originRes = await fetch(
          `${SB_URL}/rest/v1/fr24_daily_cache?flight_date=eq.${date}&airport_iata=eq.${originIata}&select=departures`,
          { headers: HEADERS }
        )
        if (originRes.ok) {
          const originRows: { departures: unknown[] }[] = await originRes.json()
          for (const originRow of originRows) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const f of (originRow.departures ?? []) as any[]) {
              const fNum = (f.num ?? '').replace(/\s+/g, '').toUpperCase()
              if (!aliases.has(fNum)) continue
              const merged = {
                ...bestRaw,
                est_dep: f.est_dep ?? bestRaw.est_dep,
                est_arr: f.est_arr ?? bestRaw.est_arr,
              }
              const { status } = effectiveStatusFor(merged)
              bestFlight = buildFlight(merged, num, status, airlineMap, date)
              break
            }
          }
        }
      }
    }

    if (bestFlight) return NextResponse.json({ ok: true, flight: bestFlight, date })
  }

  return NextResponse.json({ ok: false, error: 'flight not found', dates }, { status: 404 })
}

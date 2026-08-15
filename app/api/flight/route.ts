import { NextResponse } from 'next/server'
import { fetchCallsignLookup, fetchIataToIcao, resolveCallsign } from '@/lib/callsign'
import { boardFromV2, type BoardFlightV2 } from '@/lib/board-v2'

export const dynamic = 'force-dynamic'

const SB_URL  = process.env.SUPABASE_URL!
const SB_KEY  = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }



const STATUS_RANK: Record<string, number> = {
  // Terminal, like Arrived — see normaliseStatus in the flightboard route.
  Arrived: 8, Landed: 8, Diverted: 8, Approaching: 7, 'En Route': 6,
  Departed: 5, Cancelled: 5, Delayed: 4, GateClosed: 3, Boarding: 3,
  Expected: 2, Scheduled: 1, Unknown: 0,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any

/**
 * The detail card for one flight, from the same board document the board tab renders.
 *
 * The cache path below asked a different question — it scanned every Syrian airport's arrivals
 * and departures for a matching number — and so could answer differently for the same flight.
 * Reading the board means the card and the row can no longer disagree.
 *
 * Two things the cache path needed disappear here. Matching no longer has to guess which
 * identifier FR24 filed under, because v2 publishes `iata_number` and `callsign` side by side.
 * And the second pass that re-read the origin airport's cache for `est_dep`/`est_arr` is gone:
 * those live on the flight row itself. That pass was also the reason Latakia and Deir ez-Zor
 * detail pages lost their estimates once browser warming stopped — only DAM and ALP were still
 * being written, so there was no origin row left to read.
 *
 * Ranked by STATUS_RANK when a number appears twice on one day, which keeps the cache path's
 * behaviour of showing the most-progressed instance.
 */
function flightFromBoard(
  board: BoardFlightV2[],
  aliases: Set<string>,
  num: string,
  airlineMap: Record<string, { name: string; flag: string; icao: string }>,
  date: string,
) {
  let best: BoardFlightV2 | null = null
  let bestRank = -1
  for (const f of board) {
    const forms = [f.iata_number, f.callsign]
      .filter(Boolean)
      .map(s => (s as string).replace(/\s+/g, '').toUpperCase())
    if (!forms.some(s => aliases.has(s))) continue
    const rank = STATUS_RANK[f.status] ?? 0
    if (rank > bestRank) { best = f; bestRank = rank }
  }
  if (!best) return null

  /*
   * airline_icao and date are not on the board contract, and both are load-bearing: the card
   * builds the ICAO callsign from the first to look up an aircraft photo, and calcDelayMin
   * needs the second to place an HH:MM against the right day.
   */
  return {
    ...best,
    airline_icao: airlineMap[best.airline_iata]?.icao ?? '',
    iata_number: num,
    date,
  }
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
    const board = await boardFromV2(date, 'flight')
    if (board) {
      const hit = flightFromBoard(board, aliases, num, airlineMap, date)
      if (hit) return NextResponse.json({ ok: true, flight: hit, date, source: 'v2' })
      // A board that answered and does not contain this number is a real "not found" for that
      // day — fall through to the next date rather than to the cache, which would reintroduce
      // the disagreement this route was migrated to remove.
      continue
    }

    /*
     * No cache fallback.
     *
     * v2 could not answer at all — a transport failure, not a miss. There used to be a second
     * path here that parsed fr24_daily_cache for the same flight, plus a pass over the origin
     * airport's departures to recover est_dep / est_arr for inbound legs.
     *
     * It went with the cache on 15 Aug. The route's own comment above already refused to fall
     * through on a *miss*, for the reason that applies just as well here: the cache is written
     * only by whoever opens /fr24 in a browser, so answering from it means serving one visitor's
     * snapshot as though it were the board, and being unable to tell which the reader got.
     *
     * A 404 is the honest answer when the board cannot be reached — it says nothing, rather than
     * saying something that may be days old.
     */
  }

  return NextResponse.json({ ok: false, error: 'flight not found', dates }, { status: 404 })
}

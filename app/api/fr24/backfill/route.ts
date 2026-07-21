import { NextResponse } from 'next/server'

export const dynamic  = 'force-dynamic'
export const maxDuration = 60

const FR24_KEY = process.env.FR24_API_KEY ?? ''
const SB_URL   = process.env.SUPABASE_URL!
const SB_KEY   = process.env.SUPABASE_ANON_KEY!

const BATCH = 15

function toISO(dt: string | null | undefined): string | null {
  if (!dt) return null
  return dt.endsWith('Z') ? dt : `${dt}Z`
}

// Day-of-week from UTC ISO datetime string (0=Sun … 6=Sat)
function dowName(iso: string): string {
  const days = ['sun','mon','tue','wed','thu','fri','sat']
  return days[new Date(iso.endsWith('Z') ? iso : iso + 'Z').getUTCDay()]
}

// Round UTC datetime to nearest Syria-local hour bucket for grouping variants
function localHHMM(iso: string): string {
  const d = new Date((iso.endsWith('Z') ? iso : iso + 'Z'))
  const local = new Date(d.getTime() + 3 * 3_600_000)
  return `${String(local.getUTCHours()).padStart(2,'0')}:${String(local.getUTCMinutes()).padStart(2,'0')}`
}

export async function GET(req: Request) {
  try {
    const secret = process.env.CRON_SECRET
    if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }
    if (!FR24_KEY) return NextResponse.json({ ok: false, error: 'FR24_API_KEY not set' }, { status: 500 })

    const now  = new Date()
    const from = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 19)
    const to   = now.toISOString().slice(0, 19)

    // ── 1. All Syria flight pairs ────────────────────────────────────────────
    const pairsRes = await fetch(
      `${SB_URL}/rest/v1/rpc/get_syria_flight_pairs`,
      {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!pairsRes.ok) return NextResponse.json({ ok: false, error: 'DB pairs fetch failed' }, { status: 502 })
    const pairs: { iata_number: string; broadcast_callsign: string; fr24_id: string | null }[] = await pairsRes.json()

    // XH (Fly Cham) IATA codes are not recognised by FR24's flights= param.
    // Query XH flights by broadcast callsign instead; all others by IATA number.
    const iataFlights:    string[] = []
    const csFlights:      string[] = []  // callsign-keyed (XH)
    const callsignToIata: Record<string, string> = {}
    const iataToCallsign: Record<string, string> = {}
    const knownFr24Ids:   Record<string, string> = {}
    for (const p of pairs) {
      if (!p.iata_number) continue
      const iata = p.iata_number.toUpperCase()
      if (p.broadcast_callsign) {
        iataToCallsign[iata] = p.broadcast_callsign
        callsignToIata[p.broadcast_callsign.toUpperCase()] = iata
      }
      if (p.fr24_id) knownFr24Ids[iata] = p.fr24_id
      if (iata.startsWith('XH') && p.broadcast_callsign) {
        csFlights.push(p.broadcast_callsign)
      } else {
        iataFlights.push(p.iata_number)
      }
    }

    // ── 2. Query FR24 in 14-day window, batches of 15 ───────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allResults: any[] = []

    const fetchBatch = async (ids: string[], paramKey: 'flights' | 'callsigns') => {
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch  = ids.slice(i, i + BATCH)
        const params = new URLSearchParams({ [paramKey]: batch.join(','), flight_datetime_from: from, flight_datetime_to: to })
        try {
          const res = await fetch(`https://fr24api.flightradar24.com/api/flight-summary/full?${params}`, {
            headers: { Accept: 'application/json', 'Accept-Version': 'v1', Authorization: `Bearer ${FR24_KEY}` },
            signal: AbortSignal.timeout(20_000),
          })
          if (!res.ok) { console.warn(`FR24 ${paramKey} batch failed: ${res.status}`); continue }
          const json = await res.json()
          const data = Array.isArray(json) ? json : (json.data ?? [])
          allResults.push(...data)
        } catch (e) { console.warn('FR24 batch error', e) }
      }
    }

    await fetchBatch(iataFlights, 'flights')
    await fetchBatch(csFlights,   'callsigns')

    // ── 3. Collect FR24 IDs & group occurrences by IATA → dep-time variant ──
    const newFr24Ids: Record<string, string> = {}

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const discoveries: Record<string, Record<string, any>> = {}

    for (const r of allResults) {
      if (!r.datetime_takeoff) continue
      // XH callsign queries return r.callsign; IATA queries return r.flight
      const rawKey = r.flight ?? r.callsign
      if (!rawKey) continue
      const iata = callsignToIata[(rawKey as string).toUpperCase()] ?? (rawKey as string).toUpperCase()

      // Collect FR24 ID (flight-summary returns it as fr24_id; fall back to id)
      const rid = r.fr24_id ?? r.id
      if (rid && !knownFr24Ids[iata] && !newFr24Ids[iata]) newFr24Ids[iata] = rid

      // Group by local dep time (round to minute — don't bucket, keep exact)
      const depLocal = localHHMM(r.datetime_takeoff)
      const arrLocal = r.datetime_landed ? localHHMM(r.datetime_landed) : null
      const dow      = dowName(r.datetime_takeoff)

      if (!discoveries[iata]) discoveries[iata] = {}
      if (!discoveries[iata][depLocal]) {
        discoveries[iata][depLocal] = {
          dep_local:  depLocal,
          arr_local:  arrLocal,
          dep_utc:    r.datetime_takeoff ? r.datetime_takeoff.slice(11, 16) : null,
          arr_utc:    r.datetime_landed  ? r.datetime_landed.slice(11, 16)  : null,
          orig_iata:  r.orig_iata ?? null,
          dest_iata:  r.dest_iata_actual ?? r.dest_iata ?? null,
          days:       new Set<string>(),
          count:      0,
          fr24_ids:   [] as string[],
        }
      }
      discoveries[iata][depLocal].days.add(dow)
      discoveries[iata][depLocal].count++
      if (rid) discoveries[iata][depLocal].fr24_ids.push(rid)
    }

    // ── 4. Write new FR24 IDs to flight_lookup ───────────────────────────────
    let idsFilled = 0
    await Promise.all(Object.entries(newFr24Ids).map(async ([iata, fr24Id]) => {
      const res = await fetch(
        `${SB_URL}/rest/v1/flight_lookup?iata_number=eq.${encodeURIComponent(iata)}`,
        {
          method: 'PATCH',
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ fr24_id: fr24Id }),
        },
      )
      if (res.ok) idsFilled++
    }))

    // ── 5. Serialise discoveries (Set → Array for JSON) ──────────────────────
    const scheduleDiscoveries = Object.entries(discoveries).map(([iata, variants]) => ({
      iata_number:   iata,
      callsign:      iataToCallsign[iata] ?? null,
      fr24_id:       knownFr24Ids[iata] ?? newFr24Ids[iata] ?? null,
      variant_count: Object.keys(variants).length,
      variants: Object.values(variants).map(v => ({
        dep_local:  v.dep_local,
        arr_local:  v.arr_local,
        dep_utc:    v.dep_utc,
        arr_utc:    v.arr_utc,
        orig_iata:  v.orig_iata,
        dest_iata:  v.dest_iata,
        days:       [...v.days].sort((a, b) => ['mon','tue','wed','thu','fri','sat','sun'].indexOf(a) - ['mon','tue','wed','thu','fri','sat','sun'].indexOf(b)),
        occurrences: v.count,
      })).sort((a, b) => a.dep_local.localeCompare(b.dep_local)),
    })).sort((a, b) => a.iata_number.localeCompare(b.iata_number))

    // Highlight flights where FR24 shows more than 1 time variant (schedule mismatch)
    const mismatches = scheduleDiscoveries.filter(f => f.variant_count > 1)

    return NextResponse.json({
      ok:              true,
      window:          { from, to },
      fr24_results:    allResults.length,
      ids_filled:      idsFilled,
      flights_found:   scheduleDiscoveries.length,
      mismatches:      mismatches.length,
      schedule:        scheduleDiscoveries,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

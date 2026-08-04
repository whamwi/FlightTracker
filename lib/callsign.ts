/**
 * Resolving a ticketed flight number to the callsign an aircraft actually broadcasts.
 *
 * Lifted out of /api/airspace so the flight board can use the same answer. It had none:
 * every board row carried callsign: null, so the map's side panel could only ever show the
 * IATA number while the map itself labelled the same aircraft by callsign — which is exactly
 * the confusion this is meant to remove.
 *
 * flight_lookup is authoritative and the prefix rule is only a guess for numbers it has
 * never seen. That guess fails whenever an airline's callsign is not <ICAO><same digits>:
 * DN541 broadcasts as DNA541 while `airlines` says DN maps to JOC, so every Dan Air flight
 * failed to match its own ADS-B contact for two weeks, indistinguishable from an aircraft
 * simply not being heard.
 */

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

let iataToIcaoCache: { map: Record<string, string>; ts: number } | null = null

export async function fetchIataToIcao(): Promise<Record<string, string>> {
  if (iataToIcaoCache && Date.now() - iataToIcaoCache.ts < 3_600_000)
    return iataToIcaoCache.map
  const res = await fetch(`${SB_URL}/rest/v1/airlines?select=iata,icao`, { headers: SB_HEADERS })
  if (!res.ok) return iataToIcaoCache?.map ?? {}
  const rows: { iata: string; icao: string }[] = await res.json()
  const map: Record<string, string> = {}
  for (const r of rows) if (r.iata && r.icao) map[r.iata.toUpperCase()] = r.icao.toUpperCase()
  iataToIcaoCache = { map, ts: Date.now() }
  return map
}

export interface CallsignLookup {
  byIata:     Record<string, string>   // XQ808  → SXS808
  byCallsign: Record<string, string>   // FYC455 → FYC455
  // Either identifier → the real IATA number. FR24 publishes the callsign as `num` for the
  // 38 flights with fr24_uses_callsign, so `num` alone cannot tell you the ticketed number:
  // Fly Cham arrives as FYC727 when a passenger's booking says XH727.
  toIata:     Record<string, string>   // FYC727 → XH727,  XQ808 → XQ808
}
let lookupCache: { map: CallsignLookup; ts: number } | null = null

export async function fetchCallsignLookup(): Promise<CallsignLookup> {
  if (lookupCache && Date.now() - lookupCache.ts < 3_600_000) return lookupCache.map
  const res = await fetch(
    `${SB_URL}/rest/v1/flight_lookup?select=iata_number,broadcast_callsign&broadcast_callsign=not.is.null`,
    { headers: SB_HEADERS },
  )
  if (!res.ok) return lookupCache?.map ?? { byIata: {}, byCallsign: {}, toIata: {} }
  const rows: { iata_number: string; broadcast_callsign: string }[] = await res.json()
  const map: CallsignLookup = { byIata: {}, byCallsign: {}, toIata: {} }
  for (const r of rows) {
    if (!r.iata_number || !r.broadcast_callsign) continue
    map.byIata[r.iata_number.toUpperCase()]            = r.broadcast_callsign.toUpperCase()
    map.byCallsign[r.broadcast_callsign.toUpperCase()] = r.broadcast_callsign.toUpperCase()
    map.toIata[r.iata_number.toUpperCase()]            = r.iata_number
    map.toIata[r.broadcast_callsign.toUpperCase()]     = r.iata_number
  }
  lookupCache = { map, ts: Date.now() }
  return map
}

/** Table first, prefix rule only for flights the table has never seen. */
/**
 * The ticketed IATA number for whatever identifier FR24 published.
 *
 * The mirror of resolveCallsign, and needed for the same reason: for the 38 flights with
 * fr24_uses_callsign, FR24's `num` IS the callsign, so passing it through as the IATA number
 * publishes FYC525 where a passenger's booking says XH525. The board did exactly that, which
 * left it disagreeing with /api/airspace about the same flight — the map card showed a single
 * code instead of the pair, and a lookup keyed on one endpoint's value missed rows from the
 * other.
 *
 * Falls back to the input: an unknown flight is better described by the code we received than
 * by nothing.
 */
export function resolveIata(num: string, lookup: CallsignLookup): string {
  return lookup.toIata[num.toUpperCase()] ?? num
}

export function resolveCallsign(num: string, lookup: CallsignLookup, iataToIcao: Record<string, string>): string {
  const up = num.toUpperCase()
  return lookup.byIata[up] ?? lookup.byCallsign[up] ?? toCallsign(up, iataToIcao)
}

// Convert FR24 flight number → ADS-B broadcast callsign.
// FR24 uses IATA format (TK849, G9434, FZ1234) or already-ICAO (FYC490, SYR123).
// ADS-B always broadcasts ICAO prefix (THY849, ABY434, FDB1234, FYC490).
// Fallback only — prefer resolveCallsign above.
function toCallsign(num: string, iataToIcao: Record<string, string>): string {
  const up = num.toUpperCase()
  // 2-char alphanumeric IATA prefix: "TK"→THY, "G9"→ABY, "FZ"→FDB
  const m2 = up.match(/^([A-Z][A-Z0-9])(\d+)$/)
  if (m2) {
    const icao = iataToIcao[m2[1]]
    if (icao) return icao + m2[2]
  }
  // 3-char alpha — already ICAO (FYC490, SYR123) or unknown; return as-is
  return up
}

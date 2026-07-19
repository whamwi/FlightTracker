import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const AIRPORT_APIS = [
  { code: 'DAM', url: 'https://damairport.gov.sy/api/flights.php' },
  { code: 'ALP', url: 'https://alpairport.gov.sy/api/flights.php' },
]

// Airport API name → airlines.name_en normalizations
const NAME_OVERRIDES: Record<string, string> = {
  'Ajet': 'Anadolujet',
  'AJet': 'Anadolujet',
  'DAN AIR': 'Dan Air',
  'Fly CHAM': 'Fly Cham',
  'flydubai': 'Flydubai',
  'Flynas': 'Flynas',
  'Kuwait Airline': 'Kuwait Airways',
  'PEGASUS': 'Pegasus Airlines',
  'ROYAL JORDANIAN': 'Royal Jordanian',
  'Syrian Airlines': 'Syrian Arab Airlines',
}

const EXCLUDED_AIRLINES = new Set(['UN', 'الأمم المتحدة', ''])

function extractFlightNumber(raw: string): string | null {
  if (!raw) return null
  const s = raw.trim()
  // 2-char IATA prefix (any combo of alpha+alpha, alpha+digit, digit+alpha) + optional space + digits
  if (/^([A-Z]{2}|[A-Z][0-9]|[0-9][A-Z])\s*[0-9]+$/i.test(s)) {
    return s.replace(/^([A-Z]{2}|[A-Z][0-9]|[0-9][A-Z])\s*/i, '')
  }
  // Bare digits
  if (/^[0-9]+$/.test(s)) return s
  // Trailing digits — handles formats like "FYC(XH491)"
  const m = s.match(/([0-9]+)$/)
  return m ? m[1] : null
}

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

async function sb(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string>),
    },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Load airlines master to build name → { id, iata } map
    const airlines: { id: number; iata: string; name_en: string }[] =
      await sb('/airlines?select=id,iata,name_en')
    const byName = new Map(airlines.map(a => [a.name_en, a]))

    // Fetch both airport APIs in parallel
    const results = await Promise.allSettled(
      AIRPORT_APIS.map(({ url }) =>
        fetch(url, {
          headers: { 'User-Agent': 'FlightTracker/1.0' },
          signal: AbortSignal.timeout(15_000),
        }).then(r => r.json())
      )
    )

    // Build the new canonical set of (airline_id, iata_number)
    const newSet = new Map<string, { airline_id: number; iata_number: string }>()
    let apiErrors = 0

    for (const result of results) {
      if (result.status === 'rejected') { apiErrors++; continue }
      const flights: Record<string, unknown>[] = (result.value as { flights?: Record<string, unknown>[] })?.flights ?? []

      for (const f of flights) {
        const rawName = ((f.airlineInfo as { nameEn?: string } | null)?.nameEn ?? f.airline ?? '') as string
        if (EXCLUDED_AIRLINES.has(rawName) || !rawName) continue

        const normalizedName = NAME_OVERRIDES[rawName] ?? rawName
        const airline = byName.get(normalizedName)
        if (!airline) continue

        const num = extractFlightNumber((f.flightNumber ?? '') as string)
        if (!num) continue

        const iataNumber = `${airline.iata}${num}`
        if (!newSet.has(iataNumber)) {
          newSet.set(iataNumber, { airline_id: airline.id, iata_number: iataNumber })
        }
      }
    }

    // Load current airport-sourced entries from flight_lookup
    const current: { id: number; iata_number: string }[] =
      await sb('/flight_lookup?select=id,iata_number&source=eq.airport')
    const currentByIata = new Map(current.map(r => [r.iata_number, r.id]))

    // Diff
    const toInsert = [...newSet.values()].filter(r => !currentByIata.has(r.iata_number))
    const toDeleteIds = [...currentByIata.entries()]
      .filter(([iata]) => !newSet.has(iata))
      .map(([, id]) => id)

    // Insert new routes
    if (toInsert.length > 0) {
      await sb('/flight_lookup', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates' },
        body: JSON.stringify(toInsert.map(r => ({ ...r, source: 'airport' }))),
      })
    }

    // Delete removed routes in batches of 100
    for (let i = 0; i < toDeleteIds.length; i += 100) {
      const batch = toDeleteIds.slice(i, i + 100)
      await sb(`/flight_lookup?id=in.(${batch.join(',')})`, { method: 'DELETE' })
    }

    return NextResponse.json({
      ok: true,
      added: toInsert.length,
      removed: toDeleteIds.length,
      unchanged: newSet.size - toInsert.length,
      total: newSet.size,
      api_errors: apiErrors,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

export type AirportRow = {
  iata: string
  city: string
  country_flag: string | null
  lat: number
  lon: number
  utc_offset: number | null
}

export type AirlineRow = {
  iata: string
  icao: string
  name_en: string
  country_flag: string | null
}

// Module-level maps — seeded with critical fallbacks, populated from /api/airports + /api/airlines on load
export const airportCity: Record<string, string>            = { DAM: 'Damascus', ALP: 'Aleppo' }
export const airportFlag: Record<string, string>            = { DAM: '🇸🇾', ALP: '🇸🇾' }
export const airportCoords: Record<string, [number, number]> = {
  DAM: [33.4114, 36.5156],
  ALP: [36.1807, 37.2244],
}
export const airportOffset: Record<string, number>          = { DAM: 3, ALP: 3 }
export const airlineByIata: Record<string, AirlineRow>      = {}
export const icaoToIata: Record<string, string>             = {}

let _loaded = false

export async function loadGeoData(): Promise<void> {
  if (_loaded) return
  _loaded = true

  const [apRes, alRes] = await Promise.allSettled([
    fetch('/api/airports'),
    fetch('/api/airlines'),
  ])

  if (apRes.status === 'fulfilled' && apRes.value.ok) {
    const rows: AirportRow[] = await apRes.value.json()
    for (const r of rows) {
      if (r.city)        airportCity[r.iata]   = r.city
      if (r.country_flag) airportFlag[r.iata]  = r.country_flag
      if (r.lat != null && r.lon != null) airportCoords[r.iata] = [r.lat, r.lon]
      if (r.utc_offset != null) airportOffset[r.iata] = Number(r.utc_offset)
    }
  }

  if (alRes.status === 'fulfilled' && alRes.value.ok) {
    const rows: AirlineRow[] = await alRes.value.json()
    for (const r of rows) {
      airlineByIata[r.iata] = r
      if (r.icao) icaoToIata[r.icao] = r.iata
    }
  }
}

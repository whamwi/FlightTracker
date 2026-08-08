export type AirportRow = {
  iata: string
  city: string
  city_ar: string | null
  name_ar: string | null
  country_ar: string | null
  country_flag: string | null
  lat: number
  lon: number
  utc_offset: number | null
}

export type AirlineRow = {
  iata: string
  icao: string
  name_en: string
  name_ar: string | null
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

/*
 * Arabic names, filled from the same fetch.
 *
 * Held in a parallel map rather than replacing airportCity, because both languages are needed
 * at once: a card can be Arabic while a share link or an aria-label stays English. The reader
 * below picks per call.
 */
export const airportCityAr: Record<string, string> = { DAM: 'دمشق', ALP: 'حلب' }
export const airportNameAr: Record<string, string> = { DAM: 'مطار دمشق الدولي', ALP: 'مطار حلب الدولي' }

/**
 * The locale the page is currently rendering in.
 *
 * Module state rather than a parameter, because `city(iata)` is called from dozens of places
 * across the board, destinations, airlines and the map — several of them module-level helpers
 * that cannot call a hook. Threading a locale through all of them would be a large change for
 * a value that is fixed by the URL and identical everywhere on the page.
 *
 * LocaleProvider sets it from the same value the layout put on <html>, so it cannot drift from
 * what the document says, including after a client-side navigation between /board and
 * /ar/board.
 */
let activeLocale: 'en' | 'ar' = 'en'
export const setActiveLocale = (l: 'en' | 'ar') => { activeLocale = l }

/**
 * The airline name in the active locale.
 *
 * Takes the English name the board already carries as the fallback, so a carrier that appears
 * in a flight before it exists in the airlines table still shows a name rather than a code.
 */
export function airlineNameFor(iata: string | null | undefined, fallback: string): string {
  if (activeLocale !== 'ar' || !iata) return fallback
  return airlineByIata[iata]?.name_ar || fallback
}

/**
 * The airport's own name for a button that means "go to this airport's board".
 *
 * Arabic gets مطار دمشق; English keeps the code, because DAM is what an English reader scans
 * for and "Damascus International Airport" would not fit the button anyway.
 */
export function airportLabelFor(iata: string): string {
  if (activeLocale !== 'ar') return iata
  // The city, not the full official name — مطار دمشق reads on a button, مطار دمشق الدولي does not.
  const city = airportCityAr[iata]
  return city ? `مطار ${city}` : (airportNameAr[iata] ?? iata)
}

/** The city name in the active locale, falling back to English when no Arabic name exists. */
export function cityFor(iata: string): string {
  if (activeLocale === 'ar') return airportCityAr[iata] ?? airportCity[iata] ?? iata
  return airportCity[iata] ?? iata
}
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
      if (r.city_ar)     airportCityAr[r.iata] = r.city_ar
      if (r.name_ar)     airportNameAr[r.iata] = r.name_ar
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

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
  /** IANA zone name. Preferred over utc_offset, which cannot describe daylight saving. */
  timezone: string | null
}

export type AirlineRow = {
  iata: string
  icao: string
  name_en: string
  name_ar: string | null
  country_flag: string | null
}

/*
 * Module-level maps — seeded with critical fallbacks, populated from /api/airports and
 * /api/airlines on load.
 *
 * All four Syrian airports are seeded, not two. The seeds are what every surface reads before the
 * fetch lands, and DEZ opened on 7 Aug without being added — so anything rendering early fell back
 * to the raw code, and in Arabic to the English name, because the Arabic maps had no entry either.
 * The values are copied from the airports table rather than typed from memory.
 *
 * This is the third time a private airport list has gone stale behind the shared one. Adding an
 * airport means checking here as well as lib/syria-airports.
 */
export const airportCity: Record<string, string>            = { DAM: 'Damascus', ALP: 'Aleppo', DEZ: 'Deir ez-Zor', LTK: 'Latakia' }
export const airportFlag: Record<string, string>            = { DAM: '🇸🇾', ALP: '🇸🇾', DEZ: '🇸🇾', LTK: '🇸🇾' }
export const airportCoords: Record<string, [number, number]> = {
  DAM: [33.4114, 36.5156],
  ALP: [36.1807, 37.2244],
  DEZ: [35.2854, 40.1760],
  LTK: [35.4011, 35.9488],
}
export const airportOffset: Record<string, number>          = { DAM: 3, ALP: 3, DEZ: 3, LTK: 3 }
/**
 * IANA zone per airport — the thing that actually knows when a clock changes.
 *
 * airportOffset is kept as the fallback for any airport without one. See lib/airport-time.ts for
 * why a stored number is not enough: Berlin was an hour out on 14 Aug 2026 and Bucharest with it.
 */
export const airportTimezone: Record<string, string>        = { DAM: 'Asia/Damascus', ALP: 'Asia/Damascus' }

/*
 * Arabic names, filled from the same fetch.
 *
 * Held in a parallel map rather than replacing airportCity, because both languages are needed
 * at once: a card can be Arabic while a share link or an aria-label stays English. The reader
 * below picks per call.
 */
export const airportCityAr: Record<string, string> = { DAM: 'دمشق', ALP: 'حلب', DEZ: 'دير الزور', LTK: 'اللاذقية' }
export const airportNameAr: Record<string, string> = { DAM: 'مطار دمشق الدولي', ALP: 'مطار حلب الدولي', DEZ: 'مطار دير الزور', LTK: 'مطار اللاذقية الدولي' }

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
/** For helpers that are called outside a component and so cannot use the hook. */
export const getActiveLocale = () => activeLocale

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
      if (r.timezone)           airportTimezone[r.iata] = r.timezone
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

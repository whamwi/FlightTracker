/**
 * The Syrian airports the product covers, in one place.
 *
 * This list was written out by hand in a dozen files, in three different versions — some had
 * DAM and ALP, some added LTK, and Deir ez-Zor opening on 5 Aug 2026 would have meant finding
 * every one of them. One was already missed: the airspace route knew DEZ was Syrian while the
 * query that fetches its board still asked for DAM, ALP and LTK, so a DEZ flight would have
 * been recognised and then never loaded.
 *
 * Adding the next airport is now a one-line change here. Latakia and Qamishli have opened and
 * closed before, and Deir ez-Zor is unlikely to be the last.
 */
export const SYRIA_AIRPORTS = ['DAM', 'ALP', 'LTK', 'DEZ'] as const

export type SyriaAirport = typeof SYRIA_AIRPORTS[number]

/** Set form, for membership tests. */
export const SYRIA_AIRPORT_SET: ReadonlySet<string> = new Set(SYRIA_AIRPORTS)

/** Comma-joined, for PostgREST `in.(…)` filters. */
export const SYRIA_AIRPORTS_CSV = SYRIA_AIRPORTS.join(',')

export function isSyrianAirport(iata: string | null | undefined): boolean {
  return !!iata && SYRIA_AIRPORT_SET.has(iata.toUpperCase())
}

/**
 * The airports offered as a tab in the UI, with the city name shown beside the code.
 *
 * Deliberately narrower than SYRIA_AIRPORTS: Latakia is recognised everywhere in the data
 * layer but has no scheduled traffic, so a tab for it would only ever be empty. Adding it
 * back is one line here, and the board, destinations and airlines pages all follow.
 */
export const BOARD_AIRPORTS = [
  { iata: 'DAM', city: 'Damascus'    },
  { iata: 'ALP', city: 'Aleppo'      },
  { iata: 'DEZ', city: 'Deir ez-Zor' },
] as const

export type BoardAirport = typeof BOARD_AIRPORTS[number]['iata']

/**
 * ICAO codes, needed where an external API identifies airports that way — FR24's
 * flight-summary endpoint, for one.
 */
export const SYRIA_ICAO: Record<string, string> = {
  DAM: 'OSDI',
  ALP: 'OSAP',
  LTK: 'OSLK',
  DEZ: 'OSDZ',
}

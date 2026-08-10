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
 * What a flight is painted on the map, and on the rail of the card that names it.
 *
 * Deir ez-Zor is blue, but not the #1d4ed8 planeIcon reserves for aircraft bound nowhere in
 * Syria. That branch draws nothing today — every live call marks its aircraft Syrian — but it
 * is still the meaning that colour carries, and one of the two would have had to move if the
 * overflight harvest is ever switched back on.
 *
 * Shared with the mobile app, which tints its plane sprites from the same three values.
 */
export const MARKER_ACCENT: Record<BoardAirport, string> = {
  DAM: '#16a34a',
  ALP: '#f97316',
  DEZ: '#0284c7',
}

/**
 * Which Syrian airport a flight belongs to, for colouring.
 *
 * Every flight on the board has a Syrian end; a domestic leg has two. The provincial end wins,
 * because that is the one worth distinguishing — Damascus is the default the eye already
 * expects, so painting a Damascus–Deir ez-Zor leg green would say nothing the map does not.
 *
 * Falls back to Damascus for the airports that come and go: Latakia has no colour of its own,
 * and green reads as "somewhere in Syria" rather than as a wrong answer.
 */
export function markerHub(dep?: string | null, arr?: string | null): BoardAirport {
  for (const hub of ['DEZ', 'ALP'] as const) if (dep === hub || arr === hub) return hub
  return 'DAM'
}

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

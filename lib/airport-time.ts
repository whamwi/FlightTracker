import { getActiveLocale, airportOffset, airportTimezone } from '@/lib/geo-data'

/**
 * What the clock says at an airport, in the reader's language.
 *
 * Every surface had its own version of this — fmtLocal and utcHHMMtoLocal on the map page,
 * popupToLocal in the map component, more on the board — each taking a number of hours and adding
 * it. They agreed with each other, and were wrong together whenever the airport observed daylight
 * saving.
 *
 * Measured 14 Aug 2026: Berlin was stored as UTC+1 and was actually +2; Bucharest stored +2,
 * actually +3. Berlin and Düsseldorf are the same zone and were stored an hour apart. Amsterdam and
 * Düsseldorf read correctly that day and go wrong in late October. It had never surfaced because
 * every Middle Eastern airport we serve is DST-free year-round — Syria abolished it in 2022, and
 * the Gulf, Jordan, Iraq and Türkiye never had it. The column only became wrong when the network
 * reached Europe.
 *
 * So the zone is an IANA name and the arithmetic belongs to Intl, which knows when each zone
 * switches. The stored offset stays as a fallback for an airport we have no zone for: wrong twice a
 * year is still better than blank.
 */

/** Latin digits always, per the house rule — only the meridiem is translated. */
const AR_AM = 'ص'
const AR_PM = 'م'

/*
 * A time and its meridiem are one token, and bidi will take them apart if allowed to.
 *
 * "8:19 م" in an Arabic card renders as "م 8:19": the digits are an LTR run and م is RTL, so under
 * a right-to-left base direction the digits go rightmost and the meridiem lands to their left,
 * reading as "PM 8:19". Measured on the deployed card — meridiem at x 252, digits at 267.
 *
 * Wrapped in a left-to-right isolate the pair is laid out on its own terms, digits then meridiem,
 * and the isolate keeps that decision from leaking into the Arabic around it. Both characters are
 * zero-width, so this stays a plain string and every caller is unchanged — which matters, because
 * the alternative is a flex row and there are a dozen call sites that want a string.
 */
const LRI = '\u2066'
const PDI = '\u2069'

function offsetFallback(iso: string, iata: string): { h: number; m: number } {
  const off = airportOffset[iata] ?? 3
  const d = new Date(new Date(iso).getTime() + Math.round(off * 3_600_000))
  return { h: d.getUTCHours(), m: d.getUTCMinutes() }
}

/** Hour and minute at the airport, as numbers, 24-hour. The one place the zone is resolved. */
export function airportClock(iso: string | null | undefined, iata: string): { h: number; m: number } | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const tz = airportTimezone[iata]
  if (!tz) return offsetFallback(iso, iata)
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms))
    const h = Number(parts.find(p => p.type === 'hour')?.value)
    const m = Number(parts.find(p => p.type === 'minute')?.value)
    return Number.isFinite(h) && Number.isFinite(m) ? { h, m } : offsetFallback(iso, iata)
  } catch {
    // An unknown zone name throws rather than returning nonsense. Fall back rather than blank.
    return offsetFallback(iso, iata)
  }
}

/**
 * Twelve-hour time with a meridiem: "9:04 PM", or "9:04 م" in Arabic.
 *
 * Midnight and noon are the cases worth stating: hour 0 reads 12 AM and hour 12 reads 12 PM, which
 * is what `h % 12 || 12` produces and what a naive `h % 12` would get wrong twice a day.
 *
 * The minute keeps its leading zero and the hour does not, which is how a clock is read aloud.
 */
export function formatAirportTime12(iso: string | null | undefined, iata: string): string {
  const c = airportClock(iso, iata)
  if (!c) return '—'
  const meridiem = getActiveLocale() === 'ar' ? (c.h < 12 ? AR_AM : AR_PM) : (c.h < 12 ? 'AM' : 'PM')
  return `${LRI}${c.h % 12 || 12}:${String(c.m).padStart(2, '0')} ${meridiem}${PDI}`
}

/** The same instant as 24-hour HH:MM, for anywhere a compact fixed-width time is wanted. */
export function formatAirportTime24(iso: string | null | undefined, iata: string): string {
  const c = airportClock(iso, iata)
  return c ? `${String(c.h).padStart(2, '0')}:${String(c.m).padStart(2, '0')}` : '—'
}

/**
 * A bare "HH:MM" timetable value, which is UTC and carries no date, rendered at the airport.
 *
 * Anchored to today so the zone lookup has a date to resolve against — without one there is no
 * answer to give, since the offset depends on the time of year. A schedule read in August and one
 * read in December are genuinely different local times for a European airport, and that is the
 * point rather than a rounding error.
 */
export function formatScheduleTime(hhmm: string | null | undefined, iata: string, hour12 = true): string {
  if (!hhmm) return '—'
  const [h, m] = hhmm.slice(0, 5).split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '—'
  const now = new Date()
  const iso = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m,
  )).toISOString()
  return hour12 ? formatAirportTime12(iso, iata) : formatAirportTime24(iso, iata)
}

/**
 * The one call every surface should make: an instant, or a bare timetable value, at an airport.
 *
 * Callers hold both shapes — `actual_dep_utc` is a full ISO instant, `dep_time_utc` is "HH:MM" of
 * UTC with no date — and every local copy of this logic sniffed for the 'T' to tell them apart.
 * Doing it once here is the point of the module.
 */
export function formatAirportTime(
  value: string | null | undefined, iata: string, hour12 = true,
): string {
  if (!value) return '—'
  if (value.includes('T')) {
    return hour12 ? formatAirportTime12(value, iata) : formatAirportTime24(value, iata)
  }
  return formatScheduleTime(value, iata, hour12)
}

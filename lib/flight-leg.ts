/**
 * Guards against one leg's times bleeding onto the next.
 *
 * The map keeps last-known flight state in a ref keyed on callsign alone, with no date, and
 * every write carries the previous values forward with `?? existing?.…`. Once an arrival was
 * set it could never be cleared — so on a route that repeats daily, yesterday's landing
 * latched onto today's flight and the card read "Arrived" while the aircraft was still
 * climbing out of its origin. SYR444 (Istanbul–Damascus, daily) did exactly that on 7 Aug 2026.
 *
 * Re-keying the ref by date would touch every one of its twenty-odd readers. This fixes it at
 * the write instead, with the only test that needs no threshold: an aircraft cannot arrive
 * before it left. A genuine arrival always follows its own departure, so a real one is never
 * discarded, and drift in our own inferred departure — which is recomputed every poll — cannot
 * trip it either.
 */
export function carryArrival(
  storedArr: string | null | undefined,
  legDep: string | null | undefined,
): string | null {
  if (!storedArr) return null
  // Nothing to compare against: keep it rather than invent a reason to drop it.
  if (!legDep) return storedArr
  const arr = Date.parse(storedArr)
  const dep = Date.parse(legDep)
  if (!Number.isFinite(arr) || !Number.isFinite(dep)) return storedArr
  return arr < dep ? null : storedArr
}

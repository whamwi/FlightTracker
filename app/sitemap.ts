import type { MetadataRoute } from 'next'

/**
 * The sitemap, built from the live timetable rather than written by hand.
 *
 * The static pages are all reachable by crawling from the home page, so listing them changes
 * little. The per-flight pages are the point: nothing links to /flight/XH525 except a button
 * inside a client-rendered board, so a crawler would never find them — and "XH525" or
 * "Damascus to Erbil flight" is exactly what somebody types into a search box. They are the
 * pages most likely to earn traffic and the only ones invisible without this.
 *
 * Regenerated hourly rather than on every request. The timetable changes daily at most, and a
 * sitemap is a hint to a crawler that visits when it likes — recomputing it per request would
 * spend a database query on something nobody reads more than once a day.
 */

export const revalidate = 3600

const BASE = 'https://www.flysyria.app'

/*
 * One entry per page with both languages attached, rather than two entries.
 *
 * That is the form Google asks for: the alternates say "these are the same page" so the pair
 * is not read as duplicates, and either can be served depending on the reader. Listing /ar
 * separately would get them indexed but leave them competing with each other.
 */
const withLanguages = (path: string) => ({
  url: `${BASE}${path === '/' ? '' : path}` || BASE,
  alternates: {
    languages: {
      en: `${BASE}${path === '/' ? '' : path}` || BASE,
      ar: `${BASE}/ar${path === '/' ? '' : path}`,
    },
  },
})

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

/** Every route the site wants indexed. /admin, /api, /embed and /fr24 are deliberately absent. */
const STATIC: { path: string; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency']; priority: number }[] = [
  { path: '/',             changeFrequency: 'hourly', priority: 1.0 },
  { path: '/board',        changeFrequency: 'hourly', priority: 0.9 },
  { path: '/map',          changeFrequency: 'hourly', priority: 0.8 },
  { path: '/destinations', changeFrequency: 'weekly', priority: 0.7 },
  { path: '/airlines',     changeFrequency: 'weekly', priority: 0.7 },
  { path: '/schedule',     changeFrequency: 'weekly', priority: 0.6 },
  { path: '/news',         changeFrequency: 'daily',  priority: 0.5 },
  { path: '/privacy',      changeFrequency: 'yearly', priority: 0.3 },
]

async function flightNumbers(): Promise<string[]> {
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/route_master?active=eq.true&select=flight_lookup(iata_number)`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, next: { revalidate } },
    )
    if (!res.ok) return []
    const rows: { flight_lookup: { iata_number: string } | null }[] = await res.json()
    // Deduped: a flight with a row per operating day is still one page.
    return [...new Set(rows.map(r => r.flight_lookup?.iata_number).filter((n): n is string => !!n))].sort()
  } catch {
    // A sitemap that omits the flight pages is worth more than a 500 that omits everything.
    return []
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()
  const flights = await flightNumbers()

  return [
    ...STATIC.map(s => ({
      ...withLanguages(s.path),
      lastModified: now,
      changeFrequency: s.changeFrequency,
      priority: s.priority,
    })),
    ...flights.map(num => ({
      ...withLanguages(`/flight/${encodeURIComponent(num)}`),
      lastModified: now,
      // The status on these changes constantly, but the page's existence and its route do not.
      changeFrequency: 'daily' as const,
      priority: 0.6,
    })),
  ]
}

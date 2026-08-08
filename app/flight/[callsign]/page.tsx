import type { Metadata } from 'next'
import { headers } from 'next/headers'
import FlightDetail from './FlightDetail'
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/lib/i18n'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!

function prettyNum(raw: string): string {
  const num = raw.replace(/\s+/g, '').toUpperCase()
  const m = num.match(/^([A-Z]{2,3})(\d+.*)$/)
  return m ? `${m[1]} ${m[2]}` : num
}

type RouteInfo = {
  dep_iata: string; arr_iata: string
  dep_city: string; arr_city: string
  dep_time: string | null; arr_time: string | null
  airline: string | null
}

/**
 * The flight's route, for the title and description.
 *
 * Worth a query per page because of what these pages looked like without one: every one of
 * the 154 carried the same sentence with only the number changed, which is the shape search
 * engines treat as thin, near-duplicate content and decline to index. The body is
 * client-rendered, so the metadata is the only text a crawler is certain to read — "Aleppo to
 * Erbil" and "Fly Cham" have to be in it or they are nowhere.
 *
 * The timetable, not live status: this is cached for a day and a delay from yesterday would
 * be worse than no delay at all. Cities come from the airports table rather than a hardcoded
 * map, the same source the client uses.
 */
async function routeInfo(iata: string, locale: Locale): Promise<RouteInfo | null> {
  try {
    const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
    const url = `${SB_URL}/rest/v1/route_master`
      + `?active=eq.true&select=dep_iata,arr_iata,dep_time_utc,arr_time_utc,flight_lookup!inner(iata_number,airlines(name_en,name_ar))`
      + `&flight_lookup.iata_number=eq.${encodeURIComponent(iata)}`
    const res = await fetch(url, { headers, next: { revalidate: 86_400 } })
    if (!res.ok) return null
    const rows: {
      dep_iata: string; arr_iata: string; dep_time_utc: string | null; arr_time_utc: string | null
      flight_lookup: { airlines: { name_en: string; name_ar: string | null } | null } | null
    }[] = await res.json()
    if (!rows.length) return null

    // A flight runs on several days at different times; the route is the same on all of them,
    // so the earliest departure stands in for the pattern rather than picking one arbitrarily.
    const r = [...rows].sort((a, b) => (a.dep_time_utc ?? '').localeCompare(b.dep_time_utc ?? ''))[0]

    const cityRes = await fetch(`${SB_URL}/rest/v1/airports?select=iata,city,city_ar&iata=in.(${r.dep_iata},${r.arr_iata})`,
      { headers, next: { revalidate: 86_400 } })
    // Arabic where we have it, English otherwise — the same fallback the pages use.
    const cities: Record<string, string> = {}
    if (cityRes.ok) {
      for (const a of await cityRes.json() as { iata: string; city: string; city_ar: string | null }[]) {
        cities[a.iata] = (locale === 'ar' ? a.city_ar : null) ?? a.city
      }
    }

    return {
      dep_iata: r.dep_iata, arr_iata: r.arr_iata,
      dep_city: cities[r.dep_iata] ?? r.dep_iata,
      arr_city: cities[r.arr_iata] ?? r.arr_iata,
      // Syria local time, which is what a traveller reads on a ticket, not UTC.
      dep_time: r.dep_time_utc ? shiftToSyria(r.dep_time_utc) : null,
      arr_time: r.arr_time_utc ? shiftToSyria(r.arr_time_utc) : null,
      airline: (locale === 'ar' ? r.flight_lookup?.airlines?.name_ar : null)
            ?? r.flight_lookup?.airlines?.name_en ?? null,
    }
  } catch {
    // Metadata is worth degrading, never worth failing a page render for.
    return null
  }
}

function shiftToSyria(hhmmss: string): string {
  const [h, m] = hhmmss.split(':').map(Number)
  const t = ((h + 3) * 60 + m) % 1440
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

export async function generateMetadata(
  { params }: { params: Promise<{ callsign: string }> }
): Promise<Metadata> {
  const { callsign } = await params
  const pretty = prettyNum(callsign)

  /*
   * The locale the middleware resolved from the /ar prefix.
   *
   * This is the text that travels: WhatsApp, which is how this product spreads, renders the
   * title and description in its link preview. A shared Arabic link showing an English card
   * is the version most people would see, because most of them never open it.
   */
  const h      = await headers()
  const raw    = h.get('x-flysyria-locale')
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE

  const info = await routeInfo(callsign.replace(/\s+/g, '').toUpperCase(), locale)

  const title = info
    ? (locale === 'ar'
        ? `${pretty} — من ${info.dep_city} إلى ${info.arr_city} · الحالة المباشرة`
        : `${pretty} — ${info.dep_city} to ${info.arr_city} · Live Status`)
    : `${pretty} · FlySyria`

  const description = info
    ? (locale === 'ar'
        ? [
            `الحالة المباشرة للرحلة ${info.airline ? info.airline + ' ' : ''}${pretty}`,
            `من ${info.dep_city} (${info.dep_iata}) إلى ${info.arr_city} (${info.arr_iata}).`,
            info.dep_time && info.arr_time
              ? `المغادرة ${info.dep_time} والوصول ${info.arr_time} بالتوقيت المحلي.`
              : '',
            'مواعيد المغادرة والوصول الفعلية والتأخيرات والتتبّع المباشر.',
          ].filter(Boolean).join(' ')
        : [
            `Live status for ${info.airline ? info.airline + ' ' : ''}${pretty}`,
            `from ${info.dep_city} (${info.dep_iata}) to ${info.arr_city} (${info.arr_iata}).`,
            info.dep_time && info.arr_time
              ? `Scheduled ${info.dep_time}, arriving ${info.arr_time} local.`
              : '',
            'Real-time departure and arrival times, delays and live tracking.',
          ].filter(Boolean).join(' '))
    : `Real-time flight status for ${pretty} — Syria airports`

  return {
    title,
    description,
    alternates: { canonical: `https://www.flysyria.app/flight/${encodeURIComponent(callsign.toUpperCase())}` },
    openGraph: { title, description, siteName: 'FlySyria', type: 'website' },
    twitter:   { card: 'summary_large_image', title, description },
  }
}

export default async function Page(
  { params }: { params: Promise<{ callsign: string }> }
) {
  const { callsign } = await params
  const num = callsign.replace(/\s+/g, '').toUpperCase()
  return <FlightDetail callsign={num} />
}

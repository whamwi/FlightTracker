import { NextRequest, NextResponse } from 'next/server'
import { LOCALES, DEFAULT_LOCALE, ROOT_LOCALE } from '@/lib/i18n'

/**
 * Two jobs, in order: serve Arabic under /ar, and gate /admin behind Basic auth.
 *
 * The locale is a path prefix rather than a cookie because the links have to survive being
 * shared. WhatsApp is how this product spreads and search is how people find it, and a cookie
 * toggle gives neither a shareable nor an indexable Arabic URL — everyone who opened a link
 * would get whichever language their own browser had last chosen.
 *
 * /ar/board rewrites to /board, so there is exactly one copy of every page and no app/[locale]
 * restructure. The locale travels as a request header the root layout reads; the URL the
 * visitor sees keeps its prefix.
 *
 * English is unprefixed. There is no /en, so every link, share and search result that exists
 * today keeps working untouched.
 */

const LOCALE_HEADER = 'x-flysyria-locale'
/*
 * The URL the visitor actually sees, prefix included.
 *
 * A layout receives no pathname, and /ar/board is rewritten to /board before it renders — so
 * without this the layout cannot tell which of the two languages it is, nor build a canonical
 * or an hreflang pair for the page. The locale header alone is not enough: the links need the
 * path as well.
 */
const PATH_HEADER   = 'x-flysyria-path'
const AR_PREFIXES   = LOCALES.filter(l => l !== DEFAULT_LOCALE).map(l => `/${l}`)

function adminGate(request: NextRequest): NextResponse | null {
  const auth = request.headers.get('authorization')

  if (!auth?.startsWith('Basic ')) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="FlightTracker Admin"' },
    })
  }

  const decoded = atob(auth.slice(6))
  const colon   = decoded.indexOf(':')
  const user    = decoded.slice(0, colon)
  const pass    = decoded.slice(colon + 1)

  if (
    user !== (process.env.ADMIN_USERNAME ?? 'admin') ||
    pass !== (process.env.ADMIN_PASSWORD ?? 'changeme')
  ) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="FlightTracker Admin"' },
    })
  }

  return null
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // ── Admin and debug: unchanged behaviour, just reached through one entry point now ──
  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')
      || pathname.startsWith('/api/debug-')) {
    return adminGate(request) ?? NextResponse.next()
  }

  // ── Locale ────────────────────────────────────────────────────────────────────────
  /*
   * `/en` exists only as a root, and only because the root itself is no longer English.
   *
   * The bare `/` now sends a visitor to Arabic (see app/page.tsx), which is right for someone
   * arriving from outside and wrong for the wordmark in the header: tapping the logo on an
   * English page would have bounced the reader into Arabic. English pages point the logo here
   * instead. There is deliberately no /en/board — English content stays unprefixed, so every
   * link and search result that already exists keeps meaning what it meant.
   */
  if (pathname === '/en') {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    const headers = new Headers(request.headers)
    headers.set(LOCALE_HEADER, 'en')
    headers.set(PATH_HEADER, pathname)
    return NextResponse.rewrite(url, { request: { headers } })
  }

  const prefix = AR_PREFIXES.find(p => pathname === p || pathname.startsWith(`${p}/`))

  if (prefix) {
    const locale = prefix.slice(1)
    const url    = request.nextUrl.clone()
    // '/ar' alone is the root page, not an empty path.
    url.pathname = pathname.slice(prefix.length) || '/'

    const headers = new Headers(request.headers)
    headers.set(LOCALE_HEADER, locale)
    headers.set(PATH_HEADER, pathname)
    return NextResponse.rewrite(url, { request: { headers } })
  }

  /*
   * ?lang=ar — Arabic without moving the path.
   *
   * The mobile app shares links in the reader's language, and an /ar path would be the natural
   * way to say so. It cannot use one: iOS matches universal links against the AASA it fetched
   * when the app was last installed, so a path we add today is not claimed by any copy of the
   * app already on a phone until that phone updates. Until then the link opens Safari — for a
   * link whose whole purpose is to be forwarded to people who may or may not have the app.
   *
   * A query string is invisible to AASA path matching, so /flight/… keeps being claimed exactly
   * as it always has been, while everything downstream — title, description, and the /ar image
   * the crawler is pointed at — reads this header and cannot tell the difference.
   *
   * The /ar prefix stays the canonical Arabic URL for the website and for search.
   */
  const wantsAr = request.nextUrl.searchParams.get('lang') === 'ar'

  /*
   * The bare root is the one URL with no language in it, so it is the one place a default has
   * to be chosen rather than read. Everything else unprefixed is English, as it always was.
   */
  const headers = new Headers(request.headers)
  headers.set(LOCALE_HEADER, wantsAr ? 'ar' : pathname === '/' ? ROOT_LOCALE : DEFAULT_LOCALE)
  headers.set(PATH_HEADER, pathname)
  return NextResponse.next({ request: { headers } })
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the API.
     *
     * The API is excluded deliberately: /api/airspace is polled every few seconds by every
     * open map, and running the middleware on it would add work to the hottest path in the
     * product for a header no route handler reads. The admin API is matched by name below
     * because that one does need the gate.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:jpg|jpeg|png|webp|svg|ico|txt|xml|json)$|api/(?!admin|debug-)).*)',
  ],
}

import { Analytics } from '@vercel/analytics/next'
import { headers } from 'next/headers'
import ErrorReporter from '@/components/ErrorReporter'
import { LocaleProvider } from '@/components/LocaleProvider'
import { DEFAULT_LOCALE, dirOf, isLocale } from '@/lib/i18n'
import type { Metadata, Viewport } from 'next'
import './globals.css'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export const metadata: Metadata = {
  title: 'FlySyria',
  description: 'Live flight status for Damascus & Aleppo — real-time arrivals, departures and live tracking.',
  openGraph: {
    title: 'FlySyria',
    description: 'Live flight status for Damascus & Aleppo — real-time arrivals, departures and live tracking.',
    url: 'https://www.flysyria.app',
    siteName: 'FlySyria',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FlySyria',
    description: 'Live flight status for Damascus & Aleppo.',
  },
  // Search Console ownership proof. Public by design — it only says who controls the domain,
  // and Google re-checks it, so it has to stay in place rather than be removed once verified.
  verification: {
    google: 'dW-YPSBWEBDjdXU-FRF0sTWKwbcm6zuLxNVVBynUpz8',
  },
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /*
   * Set on every request by the middleware, from the /ar path prefix. Read here rather than in
   * the pages because the pages are client components and cannot see request headers — and
   * because lang and dir belong on <html>, which only this layout owns.
   *
   * dir is what does the actual mirroring work: the layout is flexbox with gap almost
   * everywhere, and that reverses on its own once the document direction changes.
   */
  const h      = await headers()
  const raw    = h.get('x-flysyria-locale')
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE

  return (
    <html lang={locale} dir={dirOf(locale)}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body className="bg-gray-950 text-white">
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
        {/*
          Vercel Web Analytics. Cookieless and with no cross-site identifiers, so it needs no
          consent banner and adds nothing to the App Privacy disclosures — which matters with
          a store submission pending.

          Enabling it in the dashboard is not enough on its own: for a Next.js app the events
          come from this component, so without it the project would show zero traffic and look
          broken rather than empty.
        */}
        {/* Reports browser errors to /admin/errors. Vercel's logs stop at the server, and a
            fault on a visitor's phone is otherwise invisible. */}
        <ErrorReporter />
        <Analytics />
      </body>
    </html>
  )
}

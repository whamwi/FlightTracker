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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body className="bg-gray-950 text-white">{children}</body>
    </html>
  )
}

import type { Metadata, Viewport } from 'next'
import './globals.css'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export const metadata: Metadata = {
  title: 'FlySyria Tracker',
  description: 'Live flight status for Damascus & Aleppo — real-time arrivals, departures and gate updates.',
  openGraph: {
    title: 'FlySyria Tracker',
    description: 'Live flight status for Damascus & Aleppo — real-time arrivals, departures and gate updates.',
    url: 'https://www.flysyria.app',
    siteName: 'FlySyria Tracker',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FlySyria Tracker',
    description: 'Live flight status for Damascus & Aleppo.',
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

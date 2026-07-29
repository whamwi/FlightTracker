import type { Metadata } from 'next'
import FlightDetail from './FlightDetail'

function prettyNum(raw: string): string {
  const num = raw.replace(/\s+/g, '').toUpperCase()
  const m = num.match(/^([A-Z]{2,3})(\d+.*)$/)
  return m ? `${m[1]} ${m[2]}` : num
}

export async function generateMetadata(
  { params }: { params: Promise<{ callsign: string }> }
): Promise<Metadata> {
  const { callsign } = await params
  const pretty = prettyNum(callsign)
  return {
    title: `${pretty} · FlySyria Tracker`,
    description: `Real-time flight status for ${pretty} — Syria airports`,
    openGraph: {
      title: `${pretty} · Flight Status`,
      description: `Track ${pretty} live on FlySyria Tracker`,
      siteName: 'FlySyria Tracker',
      images: [{ url: 'https://www.flysyria.app/flysyria-og-image.png', width: 1200, height: 630 }],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: `${pretty} · Flight Status`,
      description: `Track ${pretty} live on FlySyria Tracker`,
      images: ['https://www.flysyria.app/flysyria-og-image.png'],
    },
  }
}

export default async function Page(
  { params }: { params: Promise<{ callsign: string }> }
) {
  const { callsign } = await params
  const num = callsign.replace(/\s+/g, '').toUpperCase()
  return <FlightDetail callsign={num} />
}

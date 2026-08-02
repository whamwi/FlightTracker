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
    title: `${pretty} · FlySyria`,
    description: `Real-time flight status for ${pretty} — Syria airports`,
    openGraph: {
      title: `${pretty} · Flight Status`,
      description: `Track ${pretty} live on FlySyria`,
      siteName: 'FlySyria',
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: `${pretty} · Flight Status`,
      description: `Track ${pretty} live on FlySyria`,
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

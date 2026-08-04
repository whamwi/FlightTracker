import { NextResponse } from 'next/server'
import { photoForReg } from '@/lib/aircraft-photo'

/**
 * Photo for a known registration.
 *
 * The upstream calls and the caching both live in lib/aircraft-photo, because the callsign
 * route needs exactly the same thing and the two had drifted into separate copies.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ reg: string }> }) {
  const { reg } = await params
  const origin  = new URL(req.url).origin
  return NextResponse.json({ url: await photoForReg(reg, origin) })
}

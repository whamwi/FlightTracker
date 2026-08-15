import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * The commit the *server* is running, for a client to compare against its own.
 *
 * Deliberately uncached at every layer. A cached answer here would report the build that was
 * current when the cache filled, which is the same class of staleness this route exists to catch.
 */
export async function GET() {
  return NextResponse.json(
    { build: process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev' },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}

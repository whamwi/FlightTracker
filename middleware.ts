import { NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
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

  return NextResponse.next()
}

// Debug routes are behind the same gate as admin. They were reachable unauthenticated in
// production: /api/debug-live spends ~53 FR24 credits per call with no rate limit and
// echoes the upstream URL back, so anyone who found it could drain the credit balance in a
// loop. Protected rather than deleted — they are useful, they just should not be open.
// `app/api/debug-*` is untracked, so these ship with the working tree on every deploy.
export const config = {
  matcher: [
    '/admin/:path*',
    '/api/admin/:path*',
    '/api/debug-hex/:path*',
    '/api/debug-live/:path*',
    '/api/debug-summary/:path*',
    '/api/debug-hex',
    '/api/debug-live',
    '/api/debug-summary',
  ],
}

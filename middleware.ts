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

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
}

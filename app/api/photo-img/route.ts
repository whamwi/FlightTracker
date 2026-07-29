import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams.get('u')
  if (!u || !u.startsWith('https://cdn.jetphotos.com/')) {
    return new Response(null, { status: 400 })
  }

  try {
    const res = await fetch(u, {
      headers: {
        'Referer': 'https://www.jetphotos.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return new Response(null, { status: res.status })
    const buf = await res.arrayBuffer()
    return new Response(buf, {
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'image/jpeg',
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    })
  } catch {
    return new Response(null, { status: 502 })
  }
}

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const ADB_KEY  = process.env.AERODATABOX_KEY!
const ADB_BASE = 'https://prod.api.market/api/v1/aedbx/aerodatabox'

function adbFetch(path: string, opts: RequestInit = {}) {
  return fetch(`${ADB_BASE}${path}`, {
    ...opts,
    headers: { 'x-api-market-key': ADB_KEY, ...(opts.headers as Record<string, string>) },
    signal: AbortSignal.timeout(12_000),
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function listSubs(): Promise<any[]> {
  const res = await adbFetch('/subscriptions/webhook')
  if (!res.ok) throw new Error(`ADB ${res.status}: ${await res.text().catch(() => '')}`)
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

export async function GET() {
  if (!ADB_KEY) {
    return NextResponse.json({ ok: false, error: 'AERODATABOX_KEY not configured' }, { status: 500 })
  }

  try {
    const subs = await listSubs()

    const flights = subs.map(s => {
      const raw = s.subjectId ?? s.subject
      const id = typeof raw === 'string' ? raw : (raw?.id ?? raw?.value ?? raw?.number ?? '')
      return {
        id:         s.id,
        flight:     id,
        isActive:   s.isActive,
        createdOn:  s.createdOnUtc,
        expiresOn:  s.expiresOnUtc ?? null,
      }
    })

    return NextResponse.json({ ok: true, count: flights.length, flights })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

// DELETE ?prefix=XH  → removes all subscriptions whose flight starts with that prefix
export async function DELETE(req: Request) {
  if (!ADB_KEY) {
    return NextResponse.json({ ok: false, error: 'AERODATABOX_KEY not configured' }, { status: 500 })
  }

  const prefix = new URL(req.url).searchParams.get('prefix')?.toUpperCase().trim()
  if (!prefix) {
    return NextResponse.json({ ok: false, error: 'Missing ?prefix= query param' }, { status: 400 })
  }

  try {
    const subs = await listSubs()
    const toDelete = subs.filter(s => {
      const raw = s.subjectId ?? s.subject
      const id: string = typeof raw === 'string' ? raw : (raw?.id ?? raw?.value ?? raw?.number ?? '')
      return id.toUpperCase().startsWith(prefix)
    })

    const deleted: string[] = []
    const errors: Record<string, string> = {}

    await Promise.all(toDelete.map(async s => {
      const raw = s.subjectId ?? s.subject
      const flight: string = typeof raw === 'string' ? raw : (raw?.id ?? raw?.value ?? raw?.number ?? s.id)
      const res = await adbFetch(`/subscriptions/webhook/${s.id}`, { method: 'DELETE' })
      if (res.ok || res.status === 404) {
        deleted.push(flight)
      } else {
        errors[flight] = `${res.status}: ${await res.text().catch(() => '')}`
      }
    }))

    return NextResponse.json({ ok: true, prefix, deleted_count: deleted.length, deleted, errors })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

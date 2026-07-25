import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!

async function sb(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey:          SB_KEY,
      Authorization:   `Bearer ${SB_KEY}`,
      'Content-Type':  'application/json',
      ...(opts.headers as Record<string, string>),
    },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export async function GET() {
  const rows = await sb(
    '/unfiled_flights?select=*&order=flight_date.desc,diff_minutes.desc.nullslast'
  )
  return NextResponse.json({ ok: true, rows })
}

export async function PATCH(req: Request) {
  const { id, reviewed } = await req.json()
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })
  await sb(`/unfiled_flights?id=eq.${id}`, {
    method:  'PATCH',
    headers: { Prefer: 'return=minimal' },
    body:    JSON.stringify({ reviewed: reviewed ?? true }),
  })
  return NextResponse.json({ ok: true })
}

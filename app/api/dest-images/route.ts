import { NextResponse } from 'next/server'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!

export const dynamic = 'force-dynamic'

export async function GET() {
  const res = await fetch(
    `${SB_URL}/rest/v1/dest_images?select=iata,image_url`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, cache: 'no-store' },
  )
  if (!res.ok) return NextResponse.json({ ok: false, images: {} })
  const rows: { iata: string; image_url: string }[] = await res.json()
  const images: Record<string, string> = {}
  for (const r of rows) images[r.iata] = r.image_url
  return NextResponse.json({ ok: true, images })
}

export async function POST(req: Request) {
  try {
    const form = await req.formData()
    const iata = (form.get('iata') as string | null)?.toUpperCase()
    const file = form.get('file') as File | null
    if (!iata || !file) return NextResponse.json({ ok: false, error: 'Missing iata or file' }, { status: 400 })
    if (file.size > 5 * 1024 * 1024) return NextResponse.json({ ok: false, error: 'File too large (max 5 MB)' }, { status: 400 })

    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
    const path = `${iata}.${ext}`
    const buf = await file.arrayBuffer()

    // Upload to Supabase Storage (upsert)
    const upRes = await fetch(`${SB_URL}/storage/v1/object/dest-images/${path}`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': file.type,
        'x-upsert': 'true',
      },
      body: buf,
    })
    if (!upRes.ok) {
      const err = await upRes.text()
      return NextResponse.json({ ok: false, error: `Storage error: ${err}` }, { status: 502 })
    }

    const publicUrl = `${SB_URL}/storage/v1/object/public/dest-images/${path}`

    // Upsert into dest_images table
    await fetch(`${SB_URL}/rest/v1/dest_images`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ iata, image_url: publicUrl, updated_at: new Date().toISOString() }),
    })

    return NextResponse.json({ ok: true, url: publicUrl })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}

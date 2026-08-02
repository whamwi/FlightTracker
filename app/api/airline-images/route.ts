import { NextResponse } from 'next/server'

/**
 * Airline card photos. Objects are keyed by airline prefix, so re-uploading replaces the
 * bytes at an unchanged path — and an unchanged URL is indistinguishable from the old image
 * to every cache between here and the user. Replacing Fly Cham's photo looked like a failed
 * upload for exactly that reason: storage had the new picture, the browser kept painting the
 * old one. The stored URL therefore carries a ?v= stamp that changes on every upload, which
 * is also what lets the object itself be cached hard rather than revalidated on every view.
 */

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!

export const dynamic = 'force-dynamic'

export async function GET() {
  const res = await fetch(
    `${SB_URL}/rest/v1/airline_images?select=prefix,image_url`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, cache: 'no-store' },
  )
  if (!res.ok) return NextResponse.json({ ok: false, images: {} })
  const rows: { prefix: string; image_url: string }[] = await res.json()
  const images: Record<string, string> = {}
  for (const r of rows) images[r.prefix] = r.image_url
  return NextResponse.json({ ok: true, images })
}

export async function POST(req: Request) {
  try {
    const form = await req.formData()
    const prefix = (form.get('prefix') as string | null)?.toUpperCase()
    const file = form.get('file') as File | null
    if (!prefix || !file) return NextResponse.json({ ok: false, error: 'Missing prefix or file' }, { status: 400 })
    if (file.size > 5 * 1024 * 1024) return NextResponse.json({ ok: false, error: 'File too large (max 5 MB)' }, { status: 400 })

    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
    const path = `${prefix}.${ext}`
    const buf = await file.arrayBuffer()

    const upRes = await fetch(`${SB_URL}/storage/v1/object/airline-images/${path}`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': file.type,
        'x-upsert': 'true',
        // Safe to cache forever: the URL is versioned, so a replacement is a new URL.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
      body: buf,
    })
    if (!upRes.ok) {
      const err = await upRes.text()
      return NextResponse.json({ ok: false, error: `Storage error: ${err}` }, { status: 502 })
    }

    const now = new Date()
    const publicUrl = `${SB_URL}/storage/v1/object/public/airline-images/${path}?v=${now.getTime()}`

    const rowRes = await fetch(`${SB_URL}/rest/v1/airline_images?on_conflict=prefix`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ prefix, image_url: publicUrl, updated_at: now.toISOString() }),
    })
    // Previously unchecked. A failure here leaves the new bytes in storage under a URL
    // nothing points at, so the upload reports success and nothing on the page changes.
    if (!rowRes.ok) {
      return NextResponse.json({ ok: false, error: `Saved the image but could not update the record: ${rowRes.status} ${await rowRes.text()}` }, { status: 502 })
    }

    return NextResponse.json({ ok: true, url: publicUrl })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}

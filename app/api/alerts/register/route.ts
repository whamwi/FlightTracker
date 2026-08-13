import { NextResponse } from 'next/server'

/**
 * Device registration and per-flight subscriptions.
 *
 * No accounts. A device is identified by its Expo push token, the same per-device model the
 * pinned flights use — which is what keeps this from needing auth it would otherwise have to
 * invent, and keeps us from holding anything that identifies a person.
 *
 * POST { token, platform, app_version }                    → register or refresh a device
 * POST { token, iata_number, flight_date, events?, on }    → subscribe or unsubscribe
 */

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }

/** Expo's token format. Checked so a malformed value cannot fill the table with junk. */
const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/

export async function POST(req: Request) {
  let body: {
    token?: string; platform?: string; app_version?: string; locale?: string
    iata_number?: string; flight_date?: string; events?: string[]; on?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 })
  }

  const token = (body.token ?? '').trim()
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json({ ok: false, error: 'invalid push token' }, { status: 400 })
  }

  // Always upsert the device: a subscribe call from a device we have not seen should register
  // it rather than fail, and last_seen_at is how a dormant install is later distinguished
  // from an active one.
  const dev = await fetch(`${SB_URL}/rest/v1/push_devices`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      token,
      platform: body.platform ?? null,
      app_version: body.app_version ?? null,
      /*
       * The language notifications will be written in.
       *
       * Allow-listed rather than stored as sent: this value is chosen by the composer later, and
       * an unrecognised one would silently fall through to English on every future alert with
       * nothing to show why. A device that sends nothing keeps whatever it had.
       */
      ...(body.locale === 'ar' || body.locale === 'en' ? { locale: body.locale } : {}),
      last_seen_at: new Date().toISOString(),
      disabled_at: null,   // a device asking again is alive, whatever Expo said before
    }),
  })
  if (!dev.ok) {
    return NextResponse.json({ ok: false, error: `device upsert ${dev.status}` }, { status: 502 })
  }

  // Registration only.
  if (!body.iata_number) return NextResponse.json({ ok: true, registered: true })

  const iata = body.iata_number.toUpperCase()
  const date = body.flight_date ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
  const on   = body.on !== false

  if (!on) {
    // Deactivated rather than deleted, so alert_sent rows keep a subscription to point at.
    const res = await fetch(
      `${SB_URL}/rest/v1/flight_alerts?token=eq.${encodeURIComponent(token)}`
      + `&iata_number=eq.${encodeURIComponent(iata)}&flight_date=eq.${date}`,
      { method: 'PATCH', headers: HEADERS, body: JSON.stringify({ active: false }) },
    )
    return NextResponse.json({ ok: res.ok, subscribed: false })
  }

  const res = await fetch(`${SB_URL}/rest/v1/flight_alerts`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      token, iata_number: iata, flight_date: date, active: true,
      ...(body.events?.length ? { events: body.events } : {}),
    }),
  })
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `subscribe ${res.status}: ${await res.text()}` }, { status: 502 })
  }
  return NextResponse.json({ ok: true, subscribed: true, iata_number: iata, flight_date: date })
}

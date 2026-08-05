import { NextResponse } from 'next/server'

/**
 * Turns the transitions alert-shadow detects into push notifications.
 *
 * The rules are the ones shadow mode measured over 14 hours and 65 events, not new ones. Two
 * findings shaped this:
 *
 *   - 9 of 29 landing transitions — 31% — had a status of "Arrived" with no timestamp behind
 *     it. Sending on those would have made nearly a third of "your flight has landed" pushes
 *     a guess. Only a confirmed actual_arr_utc sends.
 *   - ETA_MOVED fires in practice (6 times), so the delay alert people actually want is real
 *     rather than theoretical.
 *
 * Events keep being written to alert_shadow either way. That table stops being a rehearsal
 * and becomes the audit log: every decision recorded, including the withheld ones, so a
 * complaint about a wrong or missing alert can be traced to the state that caused it.
 *
 * Nothing is sent for a flight nobody subscribed to, so a quiet night costs one query.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send'

/** Expo accepts up to 100 messages per request. */
const CHUNK = 100

type Shadow = {
  id: number; iata_number: string; flight_date: string
  event: string; detail: string | null; would_send: boolean; created_at: string
}

type Sub = { token: string; iata_number: string; flight_date: string; events: string[] }

/** What the notification actually says. Plain, and never more precise than the data. */
function compose(event: string, num: string, detail: string | null): { title: string; body: string } | null {
  const t = (s: string) => (detail?.match(/\d{2}:\d{2}/)?.[0] ?? s)
  switch (event) {
    case 'DEPARTED':  return { title: `${num} has departed`, body: `Off at ${t('the gate')} UTC.` }
    case 'LANDED':    return { title: `${num} has landed`,   body: `Down at ${t('the gate')} UTC.` }
    case 'ETA_MOVED': {
      const m = detail?.match(/([+-]\d+)m/)?.[1]
      if (!m) return null
      const mins = Number(m)
      return {
        title: `${num} arrival ${mins > 0 ? 'delayed' : 'moved earlier'}`,
        body: `Now expected ${Math.abs(mins)} minutes ${mins > 0 ? 'later' : 'earlier'} than scheduled.`,
      }
    }
    case 'CANCELLED': return { title: `${num} is cancelled`, body: 'Check with the airline for options.' }
    default:          return null
  }
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  // Only transitions this run has not already acted on. A generous window rather than "since
  // the last run": a missed run should catch up, and alert_sent's unique constraint is what
  // actually prevents a repeat.
  const since = new Date(Date.now() - 60 * 60_000).toISOString()
  const shRes = await fetch(
    `${SB_URL}/rest/v1/alert_shadow?created_at=gte.${since}&would_send=is.true&select=*&order=created_at.asc`,
    { headers: HEADERS, cache: 'no-store' },
  )
  if (!shRes.ok) return NextResponse.json({ ok: false, error: `shadow ${shRes.status}` }, { status: 502 })
  const events: Shadow[] = await shRes.json()
  if (!events.length) return NextResponse.json({ ok: true, events: 0, sent: 0 })

  // Everyone subscribed to any of the flights that moved.
  const nums = [...new Set(events.map(e => e.iata_number))]
  const subRes = await fetch(
    `${SB_URL}/rest/v1/flight_alerts?active=is.true&iata_number=in.(${nums.map(encodeURIComponent).join(',')})`
    + `&select=token,iata_number,flight_date,events`,
    { headers: HEADERS, cache: 'no-store' },
  )
  const subs: Sub[] = subRes.ok ? await subRes.json() : []
  if (!subs.length) return NextResponse.json({ ok: true, events: events.length, subscribers: 0, sent: 0 })

  // Already-sent pairs, so a re-run is silent rather than a second buzz.
  const sentRes = await fetch(
    `${SB_URL}/rest/v1/alert_sent?sent_at=gte.${since}&select=token,iata_number,flight_date,event`,
    { headers: HEADERS, cache: 'no-store' },
  )
  const already = new Set(
    (sentRes.ok ? await sentRes.json() : []).map(
      (r: { token: string; iata_number: string; flight_date: string; event: string }) =>
        `${r.token}|${r.iata_number}|${r.flight_date}|${r.event}`),
  )

  type Msg = { to: string; title: string; body: string; sound: 'default'; data: Record<string, string> }
  const messages: Msg[] = []
  const audit: Record<string, unknown>[] = []

  for (const e of events) {
    for (const s of subs) {
      if (s.iata_number !== e.iata_number || s.flight_date !== e.flight_date) continue
      if (!s.events.includes(e.event)) continue
      const key = `${s.token}|${e.iata_number}|${e.flight_date}|${e.event}`
      if (already.has(key)) continue
      already.add(key)   // guards against two shadow rows for the same transition in one run
      const text = compose(e.event, e.iata_number, e.detail)
      if (!text) continue
      messages.push({
        to: s.token, ...text, sound: 'default',
        data: { iata_number: e.iata_number, flight_date: e.flight_date, event: e.event },
      })
      audit.push({
        token: s.token, iata_number: e.iata_number, flight_date: e.flight_date,
        event: e.event, detail: e.detail,
      })
    }
  }

  if (!messages.length) {
    return NextResponse.json({ ok: true, events: events.length, subscribers: subs.length, sent: 0 })
  }

  let sent = 0
  const failures: string[] = []
  for (let i = 0; i < messages.length; i += CHUNK) {
    const batch = messages.slice(i, i + CHUNK)
    const res = await fetch(EXPO_PUSH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(batch),
    })
    const out = res.ok ? await res.json() : null
    const tickets: { status?: string; message?: string; details?: { error?: string } }[] = out?.data ?? []

    batch.forEach((m, j) => {
      const t = tickets[j]
      const ok = t?.status === 'ok'
      if (ok) sent++
      else failures.push(t?.message ?? `HTTP ${res.status}`)
      const a = audit[i + j]
      if (a) { a.ok = ok; a.error = ok ? null : (t?.message ?? `HTTP ${res.status}`) }

      // A device that has uninstalled or revoked permission should stop being tried. Expo
      // says so explicitly; anything else is transient and worth retrying later.
      if (t?.details?.error === 'DeviceNotRegistered') {
        fetch(`${SB_URL}/rest/v1/push_devices?token=eq.${encodeURIComponent(m.to)}`, {
          method: 'PATCH', headers: HEADERS,
          body: JSON.stringify({ disabled_at: new Date().toISOString() }),
        }).catch(() => {})
      }
    })
  }

  if (audit.length) {
    await fetch(`${SB_URL}/rest/v1/alert_sent`, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(audit),
    })
  }

  return NextResponse.json({
    ok: true, events: events.length, subscribers: subs.length,
    sent, failed: messages.length - sent, failures: failures.slice(0, 5),
  })
}

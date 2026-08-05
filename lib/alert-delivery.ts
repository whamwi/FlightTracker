/**
 * Turning a detected transition into a push notification.
 *
 * This lived inside the alert-send cron, which read transitions out of alert_shadow five
 * minutes after another cron wrote them there. The detection pass already holds the
 * transitions in hand the moment it computes them, so that hand-off cost every user up to ten
 * minutes for nothing — the board knew a flight had landed long before the phone did.
 *
 * So delivery moved here, where both callers can use it:
 *
 *   - alert-shadow sends inline, the moment it detects something. This is the fast path.
 *   - alert-send remains as a sweep over the last hour, catching anything the inline attempt
 *     failed to deliver — an Expo blip, a function that timed out mid-send. alert_sent's
 *     unique constraint is what makes running both safe.
 *
 * The rules themselves are unchanged: shadow mode measured them over 14 hours and 65 events,
 * and 9 of 29 landing transitions turned out to be a status of "Arrived" with no timestamp
 * behind it. Only confirmed transitions reach a phone.
 */

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send'

/** Expo accepts up to 100 messages per request. */
const CHUNK = 100

/** Only the fields delivery needs, so a freshly detected row and a stored one both fit. */
export type Transition = {
  iata_number: string
  flight_date: string
  event: string
  detail: string | null
}

type Sub = { token: string; iata_number: string; flight_date: string; events: string[] }

export type DeliveryResult = {
  events: number
  subscribers: number
  sent: number
  failed: number
  failures: string[]
}

/**
 * What the notification says.
 *
 * Times are Damascus local. The board, the app and the airport displays all speak local time,
 * and a UTC timestamp in a push — "down at 12:55" for a flight that landed at 15:55 — reads as
 * a bug to the person holding the phone.
 */
function damascusTime(iso: string | null): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  // Syria is UTC+3 year-round; DST was abolished in 2022.
  return new Date(t + 3 * 3_600_000).toISOString().slice(11, 16)
}

/** Plain, and never more precise than the data behind it. */
export function compose(event: string, num: string, detail: string | null): { title: string; body: string } | null {
  // The detail carries an ISO timestamp for the movement events; fall back to the bare phrase
  // when it does not, rather than printing a half-parsed time.
  const at = damascusTime(detail?.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/)?.[0] ?? null)

  switch (event) {
    case 'DEPARTED':
      return { title: `${num} has departed`, body: at ? `Took off at ${at}.` : 'Now airborne.' }
    case 'LANDED':
      return { title: `${num} has landed`, body: at ? `Touched down at ${at}.` : 'Now on the ground.' }
    case 'ETA_MOVED': {
      const m = detail?.match(/([+-]\d+)m/)?.[1]
      if (!m) return null
      const mins = Number(m)
      const eta = damascusTime(detail?.match(/→ (\S+)/)?.[1] ?? null)
      return {
        title: `${num} arrival ${mins > 0 ? 'delayed' : 'moved earlier'}`,
        body: eta
          ? `Now expected ${eta}, ${Math.abs(mins)} minutes ${mins > 0 ? 'later' : 'earlier'}.`
          : `Now expected ${Math.abs(mins)} minutes ${mins > 0 ? 'later' : 'earlier'} than scheduled.`,
      }
    }
    case 'CANCELLED':
      return { title: `${num} is cancelled`, body: 'Check with the airline for options.' }
    default:
      return null
  }
}

/**
 * Send what these transitions are owed, and record it.
 *
 * Returns without touching the network when nobody is subscribed to any of the flights that
 * moved, which is the common case — a quiet night costs one query.
 */
export async function deliver(events: Transition[]): Promise<DeliveryResult> {
  const empty: DeliveryResult = { events: events.length, subscribers: 0, sent: 0, failed: 0, failures: [] }
  if (!events.length) return empty

  const nums = [...new Set(events.map(e => e.iata_number))]
  const subRes = await fetch(
    `${SB_URL}/rest/v1/flight_alerts?active=is.true&iata_number=in.(${nums.map(encodeURIComponent).join(',')})`
    + `&select=token,iata_number,flight_date,events`,
    { headers: HEADERS, cache: 'no-store' },
  )
  const subs: Sub[] = subRes.ok ? await subRes.json() : []
  if (!subs.length) return empty

  // Already-sent pairs, so the inline send and the sweep cannot both buzz the same phone.
  const since = new Date(Date.now() - 60 * 60_000).toISOString()
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
      already.add(key)   // guards against two rows for the same transition in one call
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

  if (!messages.length) return { ...empty, subscribers: subs.length }

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

      // A device that has uninstalled or revoked permission should stop being tried. Expo says
      // so explicitly; anything else is transient and worth the sweep retrying later.
      if (t?.details?.error === 'DeviceNotRegistered') {
        fetch(`${SB_URL}/rest/v1/push_devices?token=eq.${encodeURIComponent(m.to)}`, {
          method: 'PATCH', headers: HEADERS,
          body: JSON.stringify({ disabled_at: new Date().toISOString() }),
        }).catch(() => {})
      }
    })
  }

  // Recorded even when the send failed: a complaint about a missing alert should be traceable
  // to the attempt and its error, not to an absence of evidence.
  if (audit.length) {
    await fetch(`${SB_URL}/rest/v1/alert_sent`, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(audit),
    })
  }

  return {
    events: events.length,
    subscribers: subs.length,
    sent,
    failed: messages.length - sent,
    failures: failures.slice(0, 5),
  }
}

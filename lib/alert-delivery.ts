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

/**
 * What the notification needs to name a place and a time.
 *
 * Written when the transition is detected and carried through storage, so the retry sweep
 * composes exactly the same sentence an hour later as the inline send would have.
 */
export type AlertContext = {
  dep_iata: string | null
  arr_iata: string | null
  dep_city: string | null
  arr_city: string | null
  /** Hours from UTC at each end, so times can be shown in the local clock of their own airport. */
  dep_offset: number | null
  arr_offset: number | null
  airline: string | null
  /** Minutes late against the timetable; negative is early, null when it cannot be computed. */
  dep_delay_min: number | null
  arr_delay_min: number | null
  /** Expected arrival, ISO — for telling someone when a flight they just watched leave will land. */
  eta_utc: string | null
}

/** Only the fields delivery needs, so a freshly detected row and a stored one both fit. */
export type Transition = {
  iata_number: string
  flight_date: string
  event: string
  detail: string | null
  /** When the transition was detected. Compared against each subscription's own age below. */
  detected_at: string
  context?: AlertContext | null
}

type Sub = {
  token: string; iata_number: string; flight_date: string; events: string[]
  created_at: string
}

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
 * Times are shown in the local clock of the airport they belong to, which is what the board
 * does — "took off 16:39" is 16:39 where it took off. Naming the city next to the time is what
 * makes that unambiguous, and it is the reason the two surfaces can never appear to disagree.
 */
function localTime(iso: string | null, utcOffsetHours: number | null): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  // Syria is UTC+3 year-round (DST abolished 2022); other airports carry their own offset.
  const off = utcOffsetHours ?? 3
  return new Date(t + off * 3_600_000).toISOString().slice(11, 16)
}

const SYRIAN = new Set(['DAM', 'ALP', 'LTK', 'DEZ'])

/**
 * The city worth naming, and how to introduce it.
 *
 * Every flight on this board has one end in Syria, so saying so adds nothing — the other end
 * is the information. A departure from Damascus is "to Jeddah"; an arrival into Damascus is
 * "from Dubai". This mirrors the strip card on the map, which names the far airport for the
 * same reason.
 *
 * Returns null when neither end is Syrian, or when the city is unknown — in which case the
 * copy falls back to naming nothing rather than printing a bare IATA code at someone.
 */
function farEnd(ctx: AlertContext | null | undefined): { preposition: 'to' | 'from'; city: string } | null {
  if (!ctx) return null
  const depSyrian = !!ctx.dep_iata && SYRIAN.has(ctx.dep_iata)
  const arrSyrian = !!ctx.arr_iata && SYRIAN.has(ctx.arr_iata)

  // Domestic (DAM→ALP) names the destination: "from Damascus" would be the half already known.
  if (depSyrian && ctx.arr_city) return { preposition: 'to',   city: ctx.arr_city }
  if (arrSyrian && ctx.dep_city) return { preposition: 'from', city: ctx.dep_city }
  return null
}

/**
 * "9 minutes late", "4h 56m late", "on time" — or nothing when the timetable is unknown.
 *
 * Big delays switch to hours because minutes stop being readable: RB516 was 296 minutes late
 * tonight, which nobody converts to "nearly five hours" while glancing at a lock screen.
 */
function lateness(min: number | null | undefined): string | null {
  if (min === null || min === undefined) return null
  const n = Math.abs(min)
  if (n < 3) return 'on time'
  const word = min > 0 ? 'late' : 'early'
  if (n < 90) return `${n} ${n === 1 ? 'minute' : 'minutes'} ${word}`
  const h = Math.floor(n / 60), m = n % 60
  return m ? `${h}h ${m}m ${word}` : `${h}h ${word}`
}

/** Plain, and never more precise than the data behind it. */
export function compose(
  event: string,
  num: string,
  detail: string | null,
  ctx?: AlertContext | null,
): { title: string; body: string } | null {
  // The detail carries an ISO timestamp for the movement events; fall back to the bare phrase
  // when it does not, rather than printing a half-parsed time.
  const stamp = detail?.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/)?.[0] ?? null
  const far   = farEnd(ctx)
  const where = far ? ` ${far.preposition} ${far.city}` : ''

  switch (event) {
    case 'DEPARTED': {
      const at   = localTime(stamp, ctx?.dep_offset ?? null)
      const late = lateness(ctx?.dep_delay_min)
      const eta  = localTime(ctx?.eta_utc ?? null, ctx?.arr_offset ?? null)

      // "XY592 to Jeddah has departed"
      const title = `${num}${where} has departed`
      const parts: string[] = []
      if (at)   parts.push(late && late !== 'on time' ? `Took off ${at}, ${late}` : `Took off ${at}`)
      // Naming the arrival city carries which clock the time is in without saying so.
      // The city is named only when it is the far end, and it is what says which clock the
      // time is in. An arrival into Syria needs no label: it is the reader's own.
      if (eta)  parts.push(far?.preposition === 'to' ? `due in ${far.city} ${eta}` : `due ${eta}`)
      return { title, body: parts.length ? `${parts.join(', ')}.` : 'Now airborne.' }
    }

    case 'LANDED': {
      const at   = localTime(stamp, ctx?.arr_offset ?? null)
      const late = lateness(ctx?.arr_delay_min)

      /*
       * Landing into Syria names where it came FROM; landing abroad names where it landed.
       *
       * Either way the sentence carries the far end, which is the half worth saying — every
       * flight here has one foot in Syria, so "has landed in Damascus" spends the title on
       * something the reader already knew when they tapped the bell.
       */
      const arrSyrian = !!ctx?.arr_iata && SYRIAN.has(ctx.arr_iata)
      const title = arrSyrian || !ctx?.arr_city
        ? `${num}${where} has landed`
        : `${num} has landed in ${ctx.arr_city}`

      const parts: string[] = []
      if (at)   parts.push(`Touched down ${at}`)
      if (late) parts.push(late)
      return { title, body: parts.length ? `${parts.join(', ')}.` : 'Now on the ground.' }
    }

    case 'ETA_MOVED': {
      const m = detail?.match(/([+-]\d+)m/)?.[1]
      if (!m) return null
      const mins = Number(m)
      const eta  = localTime(detail?.match(/→ (\S+)/)?.[1] ?? null, ctx?.arr_offset ?? null)
      const n    = Math.abs(mins)
      const unit = n === 1 ? 'minute' : 'minutes'

      return {
        title: `${num}${where} is ${mins > 0 ? 'delayed' : 'arriving earlier'}`,
        body: eta
          ? `Now expected ${eta}${far?.preposition === 'to' ? ` in ${far.city}` : ''}, ${n} ${unit} ${mins > 0 ? 'later' : 'earlier'}.`
          : `Now expected ${n} ${unit} ${mins > 0 ? 'later' : 'earlier'} than scheduled.`,
      }
    }

    case 'CANCELLED':
      return {
        title: `${num}${where} is cancelled`,
        body: ctx?.airline ? `Check with ${ctx.airline} for options.` : 'Check with the airline for options.',
      }

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
    + `&select=token,iata_number,flight_date,events,created_at`,
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
      /*
       * Nothing that happened before the bell was tapped.
       *
       * The sweep re-offers the last hour of transitions so a failed delivery can be retried,
       * and that window does not know when anyone subscribed. Someone following a flight that
       * departed forty minutes ago would be told it had just departed — an alert that is not
       * merely late but wrong, and the exact kind that destroys trust in the feature.
       *
       * Observed rather than theorised: RB443's departure was detected at 16:58 and a
       * subscription arrived at 18:00. It missed the window by three minutes.
       */
      if (Date.parse(e.detected_at) < Date.parse(s.created_at)) continue
      const key = `${s.token}|${e.iata_number}|${e.flight_date}|${e.event}`
      if (already.has(key)) continue
      already.add(key)   // guards against two rows for the same transition in one call
      const text = compose(e.event, e.iata_number, e.detail, e.context)
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

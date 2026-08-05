import { NextResponse } from 'next/server'
import { deliver, type Transition } from '@/lib/alert-delivery'

/**
 * The safety net behind alert-shadow's inline delivery.
 *
 * Detection sends its own notifications now, the moment it spots a transition, so this no
 * longer carries the fast path — it exists for the attempts that failed. An Expo hiccup, a
 * function that timed out mid-send, a deploy landing between detection and delivery: in each
 * case the transition is safely in alert_shadow and nothing has reached the phone.
 *
 * So it re-offers the last hour of confirmed transitions and lets alert_sent's unique
 * constraint decide what is actually owed. Anything already delivered is skipped, which is
 * what makes running both paths safe. On a healthy hour this sends nothing and costs three
 * queries.
 *
 * Every 15 minutes rather than every 5: a retry that runs three times as often as it can
 * possibly help is just load.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  // A generous window rather than "since the last run": a missed run should catch up, and
  // alert_sent is what actually prevents a repeat.
  const since = new Date(Date.now() - 60 * 60_000).toISOString()
  const shRes = await fetch(
    `${SB_URL}/rest/v1/alert_shadow?created_at=gte.${since}&would_send=is.true`
    + `&select=iata_number,flight_date,event,detail,context,created_at&order=created_at.asc`,
    { headers: HEADERS, cache: 'no-store' },
  )
  if (!shRes.ok) return NextResponse.json({ ok: false, error: `shadow ${shRes.status}` }, { status: 502 })

  // created_at is the shadow row's own timestamp; deliver() reads it as detected_at.
  const rows: (Transition & { created_at: string })[] = await shRes.json()
  const events: Transition[] = rows.map(r => ({ ...r, detected_at: r.created_at }))
  const delivery = await deliver(events)

  return NextResponse.json({ ok: true, mode: 'retry-sweep', ...delivery })
}

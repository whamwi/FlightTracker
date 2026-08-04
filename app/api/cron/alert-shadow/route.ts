import { NextResponse } from 'next/server'

/**
 * Alert rules running in shadow: detect the transitions a push notification would be sent
 * for, and write them down instead of sending anything.
 *
 * Nothing here delivers a notification. The point is to read back several days of decisions
 * before a single one reaches a phone, because a wrong alert is far worse than a missing one
 * — it wakes someone at 04:00 to tell them a flight landed that has not. This project has
 * already produced every ingredient for that mistake: a board reporting `Arrived` with no
 * arrival timestamp, FR24 labelling flights "Diverted to AMM" off spoofed ADS-B, and a
 * route_master departure time 25 minutes wrong that FR24 agreed with.
 *
 * So every rule below fires on a CONFIRMED transition — an actual timestamp — and anything
 * inferred is recorded with would_send=false and a reason. Those withheld rows are the
 * interesting output: they measure how often the data would have lied.
 */

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const SB_URL = process.env.SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_ANON_KEY!
const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }

/** Movement in the arrival estimate worth telling someone about. */
const ETA_MOVE_MIN = 15

/**
 * The public host, not this deployment's own URL.
 *
 * Deriving the origin from req.url gives the per-deployment hostname, which sits behind
 * Vercel's deployment protection — so the board fetch came back 401 and every run bailed out
 * before writing a row. The other crons here already use this constant; this one should have
 * from the start.
 */
const SELF = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.flysyria.app'

type Board = {
  iata_number: string
  status: string
  actual_dep_utc: string | null
  actual_arr_utc: string | null
  revised_arr_utc: string | null
  arr_time_utc: string | null
}

type Snapshot = {
  iata_number: string
  flight_date: string
  status: string | null
  actual_dep_utc: string | null
  actual_arr_utc: string | null
  eta_utc: string | null
}

type ShadowRow = {
  iata_number: string
  flight_date: string
  event: string
  detail: string
  would_send: boolean
}

function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const ta = Date.parse(a), tb = Date.parse(b)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null
  return Math.round((ta - tb) / 60_000)
}

/** Syria-local date, which is how the board is keyed. */
function syriaDate(): string {
  return new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const date = new URL(req.url).searchParams.get('date') ?? syriaDate()

  const boardRes = await fetch(`${SELF}/api/flightboard?date=${date}`, { cache: 'no-store' })
  if (!boardRes.ok) {
    return NextResponse.json({ ok: false, error: `flightboard ${boardRes.status}` }, { status: 502 })
  }
  const flights: Board[] = (await boardRes.json()).flights ?? []

  const prevRes = await fetch(
    `${SB_URL}/rest/v1/flight_state_snapshot?flight_date=eq.${date}&select=*`,
    { headers: HEADERS, cache: 'no-store' },
  )
  const prev: Snapshot[] = prevRes.ok ? await prevRes.json() : []
  const prevByNum = new Map(prev.map(p => [p.iata_number, p]))

  const shadow: ShadowRow[] = []
  const snapshots: Snapshot[] = []

  for (const f of flights) {
    const num = f.iata_number
    if (!num) continue

    const eta = f.actual_arr_utc ?? f.revised_arr_utc ?? f.arr_time_utc ?? null
    const now: Snapshot = {
      iata_number: num,
      flight_date: date,
      status: f.status ?? null,
      actual_dep_utc: f.actual_dep_utc ?? null,
      actual_arr_utc: f.actual_arr_utc ?? null,
      eta_utc: eta,
    }
    snapshots.push(now)

    const was = prevByNum.get(num)
    // First sighting establishes a baseline. Emitting on it would announce every flight's
    // current state the first time the cron ran, which is history, not news.
    if (!was) continue

    const push = (event: string, detail: string, would_send = true) =>
      shadow.push({ iata_number: num, flight_date: date, event, detail, would_send })

    // ── Departed ────────────────────────────────────────────────────────────
    if (!was.actual_dep_utc && now.actual_dep_utc) {
      push('DEPARTED', `off at ${now.actual_dep_utc}`)
    }

    // ── Landed ──────────────────────────────────────────────────────────────
    // Only on a real timestamp. The status alone flipping to Arrived is exactly the case
    // that has been observed without any arrival time behind it.
    if (!was.actual_arr_utc && now.actual_arr_utc) {
      push('LANDED', `down at ${now.actual_arr_utc}`)
    } else if (!now.actual_arr_utc && now.status === 'Arrived' && was.status !== 'Arrived') {
      push('LANDED', 'status says Arrived but no actual_arr_utc — inferred, not confirmed', false)
    }

    // ── Arrival estimate moved ──────────────────────────────────────────────
    if (!now.actual_arr_utc) {
      const moved = minutesBetween(now.eta_utc, was.eta_utc)
      if (moved !== null && Math.abs(moved) >= ETA_MOVE_MIN) {
        push('ETA_MOVED', `${moved > 0 ? '+' : ''}${moved}m → ${now.eta_utc}`)
      }
    }

    // ── Cancelled / diverted ────────────────────────────────────────────────
    if (now.status !== was.status) {
      if (now.status === 'Cancelled') push('CANCELLED', `was ${was.status}`)
      // Diversions have come from FR24 reading spoofed positions, so this is recorded and
      // withheld until it can be corroborated against a second source.
      if (now.status === 'Diverted') {
        push('DIVERTED', `was ${was.status} — single-source, unverified`, false)
      }
    }
  }

  if (shadow.length) {
    await fetch(`${SB_URL}/rest/v1/alert_shadow`, {
      method: 'POST', headers: HEADERS, body: JSON.stringify(shadow),
    })
  }

  if (snapshots.length) {
    await fetch(`${SB_URL}/rest/v1/flight_state_snapshot`, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(snapshots.map(s => ({ ...s, updated_at: new Date().toISOString() }))),
    })
  }

  return NextResponse.json({
    ok: true,
    date,
    flights: flights.length,
    detected: shadow.length,
    would_send: shadow.filter(s => s.would_send).length,
    withheld: shadow.filter(s => !s.would_send).length,
    events: shadow,
  })
}

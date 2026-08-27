/**
 * The flight popup, shared by both maps.
 *
 * Lifted out of components/Map.tsx unchanged, so that V3 shows the SAME popup rather than a
 * poorer second one. A different popup on each map would confound the very comparison the v2/v3
 * toggle exists to make: the toggle is meant to isolate one variable — where the marker goes —
 * and two popups that disagree about anything else muddy every reading.
 *
 * ── What is parameterised, and why only this ──
 *
 * The STATUS. V2 derives it from timestamps and its predictor's state: arrived if hasArrived(),
 * else signal-lost if the track was lost, else projected if dead-reckoning, else in air. That
 * derivation is the one thing V3 removes — /v2/live has already decided the phase, from the same
 * fix the marker is drawn from.
 *
 * Everything else — the logo, the route, the progress bar, the local times, the distance
 * remaining, the aircraft type, the photo — is presentation. It does not care where the position
 * came from, so both maps render it identically.
 *
 * ── The airports lookup ──
 *
 * Passed in rather than read from a module-level cache. Map.tsx populates _apCoords and _apFlag
 * from its own fetches and reads them in 26 other places; moving them here would have meant
 * touching all of those, so they come in as an argument and this module stays pure.
 */

import { translate, counted } from './i18n.ts'
import { getActiveLocale, cityFor, airlineByIata } from './geo-data.ts'
import { airlineLogo, LOGO_WHITE_BG } from './airlines.ts'
import { airportTimeParts } from './airport-time.ts'
import { hasArrived } from './flight-status.ts'
import {
  airportFlag as _apFlag, airportCoords as _apCoords, airportOffset as _apOffset,
  airlineByIata as _alByIata, icaoToIata as _icaoToIata,
} from './geo-data.ts'

export interface Aircraft {
  hex: string
  /** Optional: present when the row came from the board, absent on a bare position. */
  eta_stable_utc?: string | null
  flight: string
  lat: number
  lon: number
  alt_baro: number | string | null
  gs: number | null
  track: number | null
  true_heading: number | null
  nic?: number
  nac_p?: number
  t: string | null
  r: string | null
  board_match:    boolean
  /**
   * Seconds since the position under this row was actually observed.
   *
   * The airspace route has emitted it all along and this component never read it, which is how a
   * card came to show a green badge over an altitude, a speed and a distance from a fix four
   * minutes old — TKJ340 into Aleppo on 15 Aug, frozen at 16.6 km and 8,025 ft while it landed.
   * The panel was already consuming the same field; the map was not, and one surface knowing a
   * fact the other does not is the shape most of these defects have taken.
   */
  fix_age_s?:     number | null
  dep_iata:       string | null
  arr_iata:       string | null
  dep_time_utc?:  string | null   // scheduled "HH:MM" UTC — popup fallback when no status
  arr_time_utc:   string | null
  duration_min:   number | null
  iata_number:    string | null
  actual_dep_utc: string | null
  actual_arr_utc: string | null
  /** The board's revised arrival, carried through so the popup need not synthesise one. */
  revised_arr_utc?: string | null
  /**
   * The board's own status for this flight, lowercased by the airspace route.
   *
   * Named apart from anything the position feed carries: this is the server's verdict on the
   * flight, not a description of the fix.
   */
  board_status?: string | null
  dep_delay_min:  number | null
  airline_iata:   string | null
  seen_at?: string
  /**
   * When the position was actually taken, as opposed to when we received it.
   *
   * The airspace route has always emitted this; the type simply never declared it, so the one
   * place that read it did so through an `as any`. It is the only honest way to tell two fixes
   * apart — see the tracking update, which used to compare ground speeds instead and froze every
   * arriving aircraft at its cruise reading.
   */
  fix_at?:  string
  stale?:   boolean
}

export interface FlightStatus {
  callsign:          string
  status:            string   // Expected | Departed | Arrived | Unknown | Cancelled
  actual_dep_utc:    string | null
  actual_arr_utc:    string | null
  scheduled_dep_utc: string | null
  scheduled_arr_utc: string | null
  revised_dep_utc:   string | null
  revised_arr_utc:   string | null
  /** The arrival estimate damped server-side — what every countdown runs to. */
  eta_stable_utc:    string | null
  dep_delay_min:     number | null
  arr_delay_min:     number | null
  aircraft_reg:      string | null
  aircraft_type:     string | null
  flight_number:     string | null
  dep_iata:          string | null
  arr_iata:          string | null
  airline_iata:      string | null
}


export function iataCity(code: string | null | undefined): string {
  return code ? cityFor(code) : '—'
}

const T = (k: string) => translate(getActiveLocale(), k)

/** Where a marker counts as on final rather than en route — the same 10 km V2 used. */
export const FINAL_RING_KM = 10

/** Upstream strings are data, not markup. V2 interpolated them raw; this does not. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}

export const RTL = () => getActiveLocale() === 'ar'

export function airlineIataFor(callsign: string, fs?: FlightStatus | null): string | null {
  if (fs?.airline_iata) return fs.airline_iata
  const src = fs?.flight_number ?? callsign
  const m = src.match(/^([A-Z0-9]{2})\d/i)
  if (m) return m[1].toUpperCase()
  const icao = callsign.replace(/\d/g, '').toUpperCase()
  return _icaoToIata[icao] ?? null
}

export function airlineNameFor(iata: string | null): string | null {
  if (!iata) return null
  const row = _alByIata[iata]
  if (!row) return null
  return (RTL() ? (row.name_ar || row.name_en) : row.name_en) ?? null
}

export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R    = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a    = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

/**
 * Kept as a thin shim over lib/airport-time so the popup resolves zones like every other surface.
 *
 * It used to add a stored number of hours, which is right for every Middle Eastern airport we serve
 * and an hour out for the European ones half the year. The signature keeps its offset argument
 * because six call sites pass one; the argument is now ignored, and the IATA code decides.
 */
export function popupToLocal(iso: string | null, _offset: number, iata = 'DAM'): string {
  if (!iso) return ''
  const { time, meridiem } = airportTimeParts(iso, iata)
  if (!meridiem) return time
  // Same intent as the panel card: the meridiem is a qualifier, so it takes the face used for
  // airline names and a smaller size rather than competing with the digits at full weight.
  return `<span dir="ltr">${time}<span style="font:500 9px/1 'Instrument Sans',system-ui;`
       + `margin-inline-start:3px;opacity:.75">${meridiem}</span></span>`
}

// Convert UTC "HH:MM" schedule time to local using airport UTC offset
export function schedToLocal(hhmm: string | null, offset: number): string {
  // A synthesised schedule entry has no times. An em dash is the honest render; the old
  // '00:00' placeholder made a flight with no timetable look like a midnight departure.
  if (!hhmm) return '—'
  const [h, m] = hhmm.split(':').map(Number)
  const total = h * 60 + m + Math.round(offset * 60)
  const lh = Math.floor(((total % 1440) + 1440) % 1440 / 60)
  const lm = ((total % 1440) + 1440) % 1440 % 60
  return `${String(lh).padStart(2,'0')}:${String(lm).padStart(2,'0')}`
}

// Arabic carries no English unit letters — see the twin in FlightDetail.
export const fmtHm = (m: number) => RTL()
  ? (m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : counted('ar', m, 'noun.minute'))
  : (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`)

/**
 * The flight number and the broadcast callsign are two different identifiers for the same
 * flight — 3L505 is what a passenger sees on a ticket and what FR24 publishes; ADY505 is
 * what the aircraft actually transmits and what every ADS-B tracker keys on. They are often
 * unrelated strings (RB444/SYR444, XQ808/SXS808, DN541/DNA541), so showing only one leaves
 * a user unable to reconcile our card with what they see elsewhere.
 *
 * Rendered as "3L505 · ADY505" — flight identity only. The aircraft type is deliberately
 * not here; this line answers "which flight is this", and the type competed with that.
 *
 * The callsign is omitted when identical to the flight number, which matters for the 38
 * flights where fr24_uses_callsign is true.
 */
export function identityLine(flightNum: string | null | undefined, callsign: string | null | undefined): string {
  const fn = (flightNum ?? '').trim()
  const cs = (callsign  ?? '').trim()
  const parts: string[] = []
  if (fn) parts.push(fn)
  if (cs && cs.toUpperCase() !== fn.toUpperCase()) parts.push(cs)
  return parts.join(' · ')
}

/**
 * `belowStr` is optional and defaults to empty, which is what keeps buildSchedulePopup honest.
 *
 * That builder draws flights projected along a stored route, where every position is computed
 * rather than observed — so a distance printed under its bar would be arithmetic on a guess, and a
 * reader has no way to tell that from a measurement. It simply never passes one.
 */
export function progressBarHtml(dep: string | null, arr: string | null, fraction: number | null, etaStr: string, belowStr = ''): string {
  if (!dep || !arr) return ''
  const fillPct  = fraction != null ? Math.max(1, Math.round(fraction * 100))       : 0
  const emptyPct = fraction != null ? Math.max(1, Math.round((1 - fraction) * 100)) : 100
  return `<div style="padding:4px 14px 12px">
        ${etaStr ? `<div style="text-align:center;color:#9ca3af;font-size:11px;margin-bottom:8px">${etaStr}</div>` : ''}
        <div style="display:flex;align-items:center;gap:8px">
          <div style="text-align:start">
            <div style="font-size:12px;color:#d1d5db;white-space:nowrap">${_apFlag[dep] ?? ''} ${iataCity(dep)}</div>
            <div style="font-size:10px;color:#6b7280;font-family:monospace">${dep}</div>
          </div>
          <div style="flex:1;display:flex;flex-direction:row;align-items:center;height:20px">
            <div style="flex:${fillPct};height:4px;border-radius:99px;background:${fraction!=null?'#3b82f6':'#374151'};min-width:0"></div>
            ${fraction != null ? `
              <div style="width:18px;height:18px;border-radius:9px;background:#1e293b;flex-shrink:0;border:1.5px solid #3b82f6;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 5px rgba(59,130,246,.3)">
                <svg width="9" height="9" viewBox="0 0 10 10" fill="#3b82f6"${RTL() ? ' style="transform:scaleX(-1)"' : ''}><path d="M.7 1.1 9.3 5 .7 8.9 2.5 5z"/></svg>
              </div>
              <div style="flex:${emptyPct};height:4px;border-radius:99px;background:#374151;min-width:0"></div>
            ` : ''}
          </div>
          <div style="text-align:end">
            <div style="font-size:12px;color:#d1d5db;white-space:nowrap">${iataCity(arr)} ${_apFlag[arr] ?? ''}</div>
            <div style="font-size:10px;color:#6b7280;font-family:monospace;text-align:end">${arr}</div>
          </div>
        </div>
        <!-- 2px here against the countdown's 8px above, which looks asymmetric written down and
             reads as even on screen: the row above this line ends in the two IATA codes, so there
             is already a band of empty space under the bar itself before the row closes. Matching
             the numbers would leave this line floating away from the bar it belongs to. -->
        ${belowStr ? `<div style="text-align:center;color:#9ca3af;font-size:11px;margin-top:2px">${belowStr}</div>` : ''}
      </div>`
}

/** What the badge says. Supplied by the caller — see the note at the top of this file. */
export type PopupStatus = { label: string; bg: string; fg: string }

export function buildPopup(
  a: Aircraft,
  lostAt?: number,
  projected?: boolean,
  fs?: FlightStatus | null,
  photoUrl?: string | null,
  /*
   * The status, when the caller already knows it.
   *
   * V2 leaves this out and the derivation below runs, exactly as it always has. V3 passes one,
   * because /v2/live has already decided the phase from the same fix the marker is drawn from —
   * so the words and the position cannot contradict each other.
   *
   * That contradiction is not hypothetical: deriving the status here from timestamps and the
   * predictor's state is how ABY433 read "signal lost" under a marker labelled ARRIVED on 14 Aug,
   * and how THY848 read "~ in air" with its landing time printed underneath it.
   */
  status?: PopupStatus,
): string {
  const callsign  = (a.flight ?? '').trim() || a.hex
  const aiata     = airlineIataFor(callsign, fs)
  const alName    = airlineNameFor(aiata) ?? (aiata ?? callsign)
  const acType    = fs?.aircraft_type ?? a.t ?? null
  const dep       = fs?.dep_iata ?? a.dep_iata ?? null
  const arr       = fs?.arr_iata ?? a.arr_iata ?? null
  const flightNum = fs?.flight_number ?? callsign

  /*
   * Arrived first, and from lib/flight-status — the rule the board, the panel and the schedule
   * marker already share.
   *
   * This popup had no arrived state at all: the three branches below were signal-lost, projected
   * and in-air, so an aircraft that had landed showed whichever of those last applied. ABY433 on
   * 14 Aug read "انقطعت الإشارة" under a marker labelled ARRIVED, and THY848 read "~ في الجو"
   * with its landing time printed directly underneath.
   *
   * Signal-lost is exactly the case that has to yield. Losing the track is how most of these
   * flights end — FR24 drops them on approach at Aleppo — so reporting the loss instead of the
   * landing describes our coverage rather than the flight.
   */
  const arrived = hasArrived({
    status:          fs?.status,
    actual_arr_utc:  fs?.actual_arr_utc ?? a.actual_arr_utc,
    actual_dep_utc:  fs?.actual_dep_utc ?? a.actual_dep_utc,
    revised_arr_utc: fs?.revised_arr_utc,
    duration_min:    a.duration_min,
  })

  // Status badge. Same colours as buildSchedulePopup's arrived state, so a flight handing over
  // between the two builders does not change appearance as it does so.
  const [statusLabel, statusBg, statusFg] = status
    ? [status.label, status.bg, status.fg]
    : arrived
    ? [T('status.arrived'), '#1e3a5f', '#60a5fa']
    : lostAt && !projected
    ? [T('status.signal_lost'), '#7f1d1d', '#f87171']
    // The tilde marks a projected position rather than an observed one.
    : projected
      ? [`~ ${T('status.in_air')}`, '#713f12', '#fbbf24']
      : [T('status.in_air'), '#166534', '#4ade80']

  // Airline logo
  const logoHtml = aiata
    ? `<img src="${airlineLogo(aiata)}"
        style="width:44px;height:44px;border-radius:10px;object-fit:contain;${LOGO_WHITE_BG.has(aiata) ? 'background:#fff;' : ''}padding:4px;flex-shrink:0"
        onerror="this.src='https://images.flightsfrom.com/airlines/100/${aiata}_100px.png';this.onerror=null">`
    : `<div style="width:44px;height:44px;border-radius:10px;background:#1f2937;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:22px">${_apFlag[dep ?? ''] || '✈'}</div>`

  const depCoord = dep ? _apCoords[dep] : null
  const arrCoord = arr ? _apCoords[arr] : null

  // ONE resolved pair of instants drives the progress bar, the countdown and the ARRIVAL
  // column. Keeping them on separate chains is how a card ends up reading "ARRIVAL 02:52"
  // beside "26m left" — each defensible alone, nonsense together.
  const depISO = fs?.actual_dep_utc ?? a.actual_dep_utc ?? null
  /*
   * eta_stable_utc ahead of revised_arr_utc: the same instant, damped once on the server so
   * every surface counts to one number.
   *
   * The countdown moved with every estimate FR24 published, and it republishes constantly —
   * RB515 alternated between two values five times in forty minutes, so a reader watched
   * "16m left" become "23m" and back. The app damped this and the site did not, which is how
   * SDR17HL read "3:42 left" here and "3 hours 39 minutes" on the phone at the same moment.
   * Now neither client damps and both read the same field. revised_arr_utc stays as the
   * fallback for anything the service has not stabilised.
   */
  const arrISO = fs?.actual_arr_utc ?? fs?.eta_stable_utc ?? fs?.revised_arr_utc ?? fs?.scheduled_arr_utc
    ?? (() => {
      const d = Date.parse(depISO ?? '')
      return Number.isFinite(d) && a.duration_min
        ? new Date(d + a.duration_min * 60_000).toISOString()
        : null
    })()

  const depMs       = Date.parse(depISO ?? '')
  const arrMs       = Date.parse(arrISO ?? '')
  // Kept for the flown-time figure below; whether it has landed is `arrived`, decided above.
  const actualArrMs = Date.parse(fs?.actual_arr_utc ?? a.actual_arr_utc ?? '')

  // Progress from time, not from a.lat/a.lon. Those freeze at the instant the signal drops,
  // so on a dead-reckoned flight the bar froze with them — while the schedule overlay
  // computed the same flight's progress from time. The result was a bar that jumped
  // position depending on which builder happened to render it that refresh. Geometry stays
  // only as a fallback for a live aircraft with no usable schedule.
  let fraction: number | null = null
  if (arrived) {
    fraction = 1
  } else if (Number.isFinite(depMs) && Number.isFinite(arrMs) && arrMs > depMs) {
    fraction = Math.max(0.02, Math.min(0.97, (Date.now() - depMs) / (arrMs - depMs)))
  } else if (depCoord && arrCoord && typeof a.lat === 'number' && typeof a.lon === 'number') {
    const total = greatCircleKm(depCoord[0], depCoord[1], arrCoord[0], arrCoord[1])
    const rem   = greatCircleKm(a.lat, a.lon, arrCoord[0], arrCoord[1])
    fraction = total > 0 ? Math.max(0.02, Math.min(0.97, 1 - rem / total)) : null
  }

  // Times (local at each airport)
  const depOffset = _apOffset[dep ?? ''] ?? 3
  const arrOffset = _apOffset[arr ?? ''] ?? 3

  let etaStr = ''
  if (arrived && Number.isFinite(actualArrMs) && Number.isFinite(depMs) && actualArrMs > depMs) {
    // Once it is down, time remaining is meaningless — how long it took is the useful number.
    etaStr = `${fmtHm(Math.round((actualArrMs - depMs) / 60_000))} ${T('label.flown')}`
  } else if (!arrived && Number.isFinite(arrMs)) {
    const remMin = Math.round((arrMs - Date.now()) / 60_000)
    if (remMin > 0) etaStr = `${fmtHm(remMin)} ${T('map.until_arrival')}`
  } else if (!arrived && arrCoord && typeof a.lat === 'number' && typeof a.lon === 'number'
             && typeof a.gs === 'number' && a.gs > 50) {
    // No arrival estimate anywhere — fall back to the geometric one. Only meaningful for a
    // genuinely live fix, which is the only case that reaches here.
    const nm = greatCircleKm(a.lat, a.lon, arrCoord[0], arrCoord[1]) / 1.852
    etaStr = `${fmtHm(Math.round(nm / a.gs * 60))} ${T('map.until_arrival')}`
  }
  // Fall back to the scheduled time carried on the aircraft when flightStatusRef has
  // nothing — the same chain buildSchedulePopup has always used. Without it the marker
  // popup rendered a bare dash while the schedule panel showed a time for the same flight
  // at the same moment: a flight surfaced as an *aircraft* is excluded from boardDeparted,
  // and boardDeparted is what populates revised_arr_utc.
  const depTimeLocal = popupToLocal(fs?.actual_dep_utc ?? fs?.revised_dep_utc ?? fs?.scheduled_dep_utc ?? null, depOffset, dep ?? 'DAM')
                    || (a.dep_time_utc ? schedToLocal(a.dep_time_utc, depOffset) : '')
  // arrISO above, not a second chain — this is the value the countdown is measured against.
  const arrTimeLocal = popupToLocal(arrISO, arrOffset, arr ?? 'DAM')
                    || (a.arr_time_utc ? schedToLocal(a.arr_time_utc, arrOffset) : '')

  // `before` puts the gap on the side facing the number, and the margin is logical: the
  // physical one put the space on the badge's outer edge under RTL, leaving it touching the
  // time it belongs to. dir=ltr keeps the sign attached to its digits — bidi otherwise
  // throws a leading + to the far end of the token.
  const delayBadge = (min: number | null | undefined) => min != null && Math.abs(min) >= 2
    ? `<span dir="ltr" style="display:inline-flex;background:#fef3c7;color:#92400e;font-size:10px;font-weight:700;padding:2px 5px;border-radius:99px;line-height:1.4;flex-shrink:0">${RTL() ? `<span>د</span><span>${Math.abs(min)}</span><span>${min > 0 ? '+' : '-'}</span>` : `${min > 0 ? '+' : ''}${min}m`}</span>`
    : ''

  /*
   * How far it still has to go, under the bar that shows how far it has come.
   *
   * Beneath rather than beside the altitude and speed, because those describe the aircraft and
   * this describes the journey — it belongs to the bar, not to the telemetry. Beneath rather than
   * above it because the line above is the countdown, and the two would compete: same information,
   * different units, stacked either side of the thing they both measure reads as a pair rather
   * than a repetition.
   *
   * Great-circle to the arrival airport, so it is a floor and not a promise wherever the routing
   * bends — and the same measurement the final ring is tested against, so the line cannot disagree
   * with the behaviour underneath it.
   *
   * Guarded exactly as the telemetry line is, and for the same reason: never while a position is
   * projected, never once the signal has dropped, never after it is down. `a.lat` is then the last
   * place we saw it, and a distance computed from that reads as current when it is not.
   *
   * Suppressed inside the final ring too. That is the one place it would be most useful and least
   * true: at 3 km a fix half a minute old is wrong by two of them, which is most of what is left,
   * and «نقترب من المدرج» is already saying the same thing without pretending to precision.
   */
  const kmToArr = (arrCoord && typeof a.lat === 'number' && typeof a.lon === 'number')
    ? greatCircleKm(a.lat, a.lon, arrCoord[0], arrCoord[1])
    : null
  const onFinal = kmToArr !== null && kmToArr < FINAL_RING_KM

  const distStr = (!projected && !lostAt && !arrived && kmToArr !== null && !onFinal)
    ? `${T('label.distance_left')}: ${Math.round(kmToArr).toLocaleString('en-US')} ${T('unit.km')}`
    : ''

  const progressHtml = progressBarHtml(dep, arr, fraction, etaStr, distStr)

  const timesHtml = (depTimeLocal || arrTimeLocal)
    ? `<div style="display:flex;background:#1f2937;padding:11px 14px">
        <div style="flex:1;text-align:start">
          <div style="font-size:9px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:${RTL() ? 'normal' : '0.6px'};margin-bottom:3px">${T('label.departure')}</div>
          <div style="display:flex;align-items:baseline;gap:7px">
            <span style="font-size:20px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums">${depTimeLocal || '—'}</span>${delayBadge(fs?.dep_delay_min)}
          </div>
        </div>
        <div style="flex:1;text-align:end">
          <div style="font-size:9px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:${RTL() ? 'normal' : '0.6px'};margin-bottom:3px">${T('label.arrival')}</div>
          <div style="display:flex;align-items:baseline;justify-content:flex-end;gap:7px">
            ${delayBadge(fs?.arr_delay_min ?? schedArrDeltaMin(a.arr_time_utc, arrISO))}<span style="font-size:20px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums">${arrTimeLocal || '—'}</span>
          </div>
        </div>
      </div>`
    : ''

  // Same clock as the arrival column directly above it. This was toLocaleTimeString(),
  // i.e. the *viewer's* zone, so a single card carried three unlabelled zones — departure
  // in the origin's, arrival in the destination's, this one in the reader's. On a mostly
  // diaspora audience that also made a signal-lost stamp read as later than the arrival
  // time beside it.
  const lostLocal = lostAt ? popupToLocal(new Date(lostAt).toISOString(), arrOffset, arr ?? 'DAM') : ''
  // Suppressed once it is down: "⚠ signal lost 05:58" under an Arrived badge reads as a fault,
  // when in fact the flight finished normally and only our view of it ended early.
  const lostLine = lostAt && !projected && !arrived
    ? `<div style="color:#ef4444;font-size:11px;padding:5px 14px;text-align:center">⚠ ${T('map.signal_lost')} ${lostLocal}</div>`
    : ''
  const drLine = projected && lostAt
    ? `<div style="color:#9ca3af;font-size:10px;padding:2px 14px 6px;text-align:center">${T('map.dead_reckoning')} ${lostLocal}</div>`
    : ''

  /*
   * Altitude and speed, and only while we actually hold a fix — the app's rule, and its reasoning
   * carries over unchanged: these must never appear for a flight being projected along a stored
   * route, because the numbers would be invented and a reader has no way to tell an invented
   * 34,000 ft from a measured one. buildSchedulePopup, which draws exactly those flights, does
   * not get this line at all.
   *
   * Nor after the signal drops: `a.alt_baro` is then the last altitude we saw, and under a
   * "signal lost" badge it reads as current. Nor once it is down.
   *
   * Digits stay Latin via toLocaleString('en-US') — the house rule wherever a number carries
   * meaning — and only the unit is translated.
   */
  /*
   * Inside the last ten kilometres, say where it is rather than what it was doing.
   *
   * At 134 knots that ring takes about two and a half minutes to cross and the map polls every
   * ten seconds, so a printed figure describes a moment already gone. ABY433 on 15 Aug read
   * "2,500 ft · 134 kt" fifteen seconds before touchdown — measured, current when taken, and
   * wrong by the time anyone read it. The values below it were 65, then 22, then 20 on the
   * rollout, and none of them could ever appear: the flight was Arrived by the next poll and an
   * arrival leaves the map.
   *
   * Ten kilometres because that is the reader's ask and it matches the geometry — beyond it a
   * ten-second lag is a few hundred feet and reads fine; inside it the aircraft is landing.
   */
  // kmToArr and onFinal are measured once, further up, where the distance line under the bar
  // first needs them. This used to declare its own `arrCoords` beside the `arrCoord` already in
  // scope — two names, one lookup, and a standing invitation to change one and not the other.
  const liveDetail = (!projected && !lostAt && !arrived && onFinal)
    ? T('map.approaching_runway')
    : (!projected && !lostAt && !arrived
      && typeof a.alt_baro === 'number' && a.alt_baro > 0)
    ? [
        `${T('label.altitude')}: ${a.alt_baro.toLocaleString('en-US')} ${T('unit.ft')}`,
        typeof a.gs === 'number' && a.gs > 0
          ? `${T('label.speed')}: ${Math.round(a.gs).toLocaleString('en-US')} ${T('unit.kts')}`
          : null,
      ].filter(Boolean).join(' · ')
    : ''
  /*
   * No dir override. It carried dir="ltr" so the digits would stay put — which they do anyway,
   * a number being laid out left-to-right inside an RTL paragraph without being told. What the
   * override actually did was pin the whole line left-to-right on an Arabic page, so a reader
   * scanning right-to-left met "قدم · 454 عقدة 35,000" instead of "35,000 قدم · 454 عقدة": each
   * value separated from its own unit and attached to the next one.
   *
   * The same override, for the same wrong reason, scrambled the board's meta strip on 13 Aug.
   */
  // Back to 14px: the distance that briefly made this line a third too long now lives under the
  // progress bar, so altitude and speed have the room they always had.
  const liveLine = liveDetail
    ? `<div style="color:#9ca3af;font-size:10.5px;padding:3px 14px 7px;text-align:center">${liveDetail}</div>`
    : ''
  const photoHtml = photoUrl
    ? `<img src="${photoUrl}" style="width:100%;height:110px;object-fit:cover;display:block">`
    : ''

  return `<div dir="${RTL() ? 'rtl' : 'ltr'}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;width:280px">
    ${photoHtml}
    <div style="display:flex;align-items:flex-start;gap:11px;padding:13px 13px 8px">
      ${logoHtml}
      <div style="flex:1;min-width:0;text-align:start">
        <div style="font-size:14px;font-weight:700;color:#f9fafb;line-height:1.25">${alName}</div>
        <div style="font-size:12px;color:#9ca3af;margin-top:2px">${identityLine(flightNum, callsign)}</div>
      </div>
      <span style="background:${statusBg};color:${statusFg};font-size:10px;font-weight:600;padding:3px 8px;border-radius:99px;flex-shrink:0;margin-top:1px">${statusLabel}</span>
    </div>
    ${progressHtml}${timesHtml}${liveLine}${lostLine}${drLine}
  </div>`
}

/**
 * Minutes an arrival differs from its scheduled time — negative when early.
 *
 * Computed here because neither source the popups reach for is ever populated:
 * scheduled_arr_utc is only carried forward from an existing entry and never set, and
 * arr_delay_min is never derived in the API at all. So the badge could not appear, and the
 * map card showed a bare arrival time while the flight board showed the same arrival with
 * its variance beside it.
 *
 * The scheduled time is a bare HH:MM, so the day is chosen as whichever puts it nearest the
 * actual arrival — otherwise an overnight leg reads as a 24-hour delay.
 */
export function schedArrDeltaMin(arrTimeUtc: string | null | undefined, arrIso: string | null): number | null {
  if (!arrTimeUtc || !arrIso) return null
  const arrMs = Date.parse(arrIso)
  const [h, m] = arrTimeUtc.split(':').map(Number)
  if (!Number.isFinite(arrMs) || !Number.isFinite(h) || !Number.isFinite(m)) return null

  const base = new Date(arrMs)
  base.setUTCHours(h, m, 0, 0)
  let best = base.getTime()
  for (const shift of [-86_400_000, 86_400_000]) {
    const cand = base.getTime() + shift
    if (Math.abs(cand - arrMs) < Math.abs(best - arrMs)) best = cand
  }
  return Math.round((arrMs - best) / 60_000)
}

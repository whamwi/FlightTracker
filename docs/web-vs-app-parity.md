# Web and app: what each has, and where they disagree

Status: audit, 15 Aug 2026. Read from both codebases, not from memory. Nothing changed to produce
it.

Repos: `~/FlightTracker` (web) and `~/FlightTrackerApp` (Expo). They share the API routes, so a
difference here is a client difference — the same JSON rendered two ways.

## Why this exists

The web gained six features in one day and the app gained none of them. That is not automatically
a problem: the two have different jobs, and a phone is not a small desktop. It becomes a problem
when the *same* fact is rendered differently, because a passenger checking a flight on the phone
and then the laptop reads two answers and reasonably concludes one of them is broken.

That failure has already cost real time this week — FAD742 arrived on the board and stayed flying
on the map, XH728 was airborne on one screen and landed on another. Both were one surface knowing
something another did not.

## Web-only

Everything here was added on 15 Aug.

| feature | where |
|---|---|
| «نقترب من المدرج» — replaces altitude and speed inside 10 km | `components/Map.tsx`, `FINAL_RING_KM` |
| Distance still to run, under the progress bar | `components/Map.tsx`, `label.distance_left` |
| Fix-age staleness gate at 150 s, with an eased catch-up | `Map.tsx` `STALE_FIX_MS`, `lib/flight-predictor.ts` `onSignalLostAt` |
| Airport colour key | `components/AirportLegend.tsx` |
| Stale-bundle banner | `components/VersionCheck.tsx`, `/api/version` |
| 12-hour time with a meridiem, resolved by IANA zone | `lib/airport-time.ts` |

Two of these are worth porting on merit rather than for symmetry:

- **The fix-age gate.** The app has no equivalent, so it presents a frozen position as current for
  as long as the server keeps listing the aircraft. On the web that was measured at five minutes
  and seventeen seconds on TKJ340 into Aleppo — a green badge over an altitude, a speed and a
  distance from a fix that had stopped updating before the descent began.
- **Airport-local 12-hour time.** The app formats `HH:MM`. The web resolves the zone through
  `Intl`, which is what caught Berlin stored as +1 while actually +2, and Berlin and Düsseldorf
  stored an hour apart in the same zone.

The version banner is **not** a missing app feature. A native app updates through the store or
`expo-updates`; a stale JavaScript bundle is not its failure mode. (The app has no `expo-updates`
wired up at all, which is separately noted as post-demo work.)

## App-only

| feature | where |
|---|---|
| Push notifications | `lib/alerts.ts`, `expo-notifications` |

The web has the server half — `cron/alert-send`, `push_devices`, `flight_alerts` — and no browser
delivery. Whether it should have one is a product question, not a parity gap.

## Both, and divergent

This is the section that matters. Everything above is a gap; this is a contradiction.

### Arrived hold — the two surfaces answer differently today

| | web | app |
|---|---|---|
| how long an arrival stays | **60 min** | **30 min** (`ARRIVED_HOLD_MIN`, `lib/flight-items.ts`) |
| how many are shown | **one per airport**, the most recent | **all of them** |
| ranked by | first moment we believed the arrival | published arrival time |

So at Damascus after a busy hour, the phone shows several arrived markers and the desktop shows
one. Neither is wrong in isolation; together they are a bug, and the web moved on 15 Aug without
the app moving with it.

The web's rule was a deliberate answer to a specific complaint — arrived tags piling onto Damascus,
which a fan, a route offset and a grouped badge all failed to make readable. The reasoning applies
to a phone at least as strongly, where the screen is smaller.

**Decision needed:** the app follows the web to one-per-airport for 60 minutes, or the web reverts
to 30 minutes and all arrivals. Not left as is.

### Agreeing already

| | note |
|---|---|
| Phase chips | Same key contract. Web `app/board/page.tsx`, app `components/PhaseChip.tsx`. Strings live client-side in both, so the server can add a phase without breaking a shipped build. |
| Marker accent colours | `MARKER_ACCENT`, same three airports, same meaning — coloured by the flight's provincial end. |
| Pins | Present in both. |

## How this was produced, and what that is worth

By grepping both trees for the symbols and strings each feature is built from. That reliably finds
**absence**, which is most of the table above.

It is weaker on *present but implemented differently* — the arrived-hold divergence only surfaced
because the constant was read, not because a grep flagged it. So treat "agreeing already" as
"nothing contradicted it", not as verified equivalence. Phase chips and marker colours were checked
by eye; pins were not.

A stronger version of this document would compare rendered output for one flight across both
clients at the same moment. That has not been done.

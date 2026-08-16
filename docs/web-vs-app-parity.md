# Web and app: where they actually differ

Status: rewritten 16 Aug 2026, replacing the 15 Aug version. Read from both codebases and, where
it mattered, by running both implementations on identical inputs.

Repos: `~/FlightTracker` (web) and `~/FlightTrackerApp` (Expo).

## Why the previous version was withdrawn

It was produced by grepping both trees for the symbols each feature is built from. That finds
**absence** and is blind to **divergence**, which it admitted — and then the blindness cost a day.

It also stated a wrong model of the web, which several ports were then built on: that the web
"draws the fix" and the app "draws the corridor". The web does **both**. It anchors to the fix when
a poll lands and advances along the route between polls — `components/Map.tsx:2985`, an animation
loop asking `store.position(cs, now)` for every callsign on every frame. Reproducing only the first
half is what left live markers on the phone standing still between polls.

## The method that worked

Run both implementations on the same inputs and diff the numbers. Two examples, each of which
found something no amount of reading had:

- Feeding both `FlightPredictor`s identical fixes: **0.00 km apart while live, 94.5 km apart the
  instant a fix went stale.** Cause was one method the web had and the app did not.
- Feeding both `PathTracker`s a tracker seeded 298 km ahead of its aircraft: the app closed to
  61 km over 40 polls; **the web grew to 440 km.**

Files look similar. Behaviour does not. Prefer the harness.

## Shared library files

Six modules exist in both repos. Only one is a real problem.

| file | state |
|---|---|
| `tracker-store.ts` | **Identical**, byte for byte. |
| `flight-predictor.ts` | **Identical in code** — the 35 differing lines are comments, after `onSignalLostAt` was ported on 15 Aug. |
| `path-tracker.ts` | **The app is ahead.** See below. |
| `airport-time.ts` | Diverged out of necessity: the app's carries a Hermes capability probe and takes the locale as a parameter, because `lib/locale` imports react-native and would make the module untestable off-device. |
| `syria-airports.ts` | Different shapes, neither ahead. `MARKER_ACCENT` is identical — DAM green, ALP orange, DEZ blue. |
| `i18n.ts` | Translations. `status.departed` and `status.in_air` are the same on both sides; see the status divergence below, which is not a translation problem. |

### path-tracker — RESOLVED 16 Aug

Ported to the web by copying the app's file wholesale (the app's was a strict superset: 29
differing code lines, all additions, identical imports). Both are now byte-identical, and the
measurement above became 224 → 132 → 78 → 61 km on both sides.

The test file was copied with it, which mattered more than it looked: the web's own 31 tests
PASSED against the new source, because they build the aircraft BEHIND the tracker and never
exercise the backward path at all.

What follows is kept as the record of what was wrong.

#### the original finding

Made in the app on 15 Aug and never carried back — `web 0, app 4`:

- a corroborated backward disagreement can correct progress (`backwardCorrectionFactor`)
- the first fix is believed rather than refused as `backward`
- the rate floor yields while chasing (`chasing`)
- a fix predating the last accepted one is rejected rather than skipping the implied-speed guard

Without them `s` can only ever increase — `clamp(this.s + this.v * dt, this.s, 1)` with a rate floor
of `nominal * minRateFactor` — so a tracker that runs ahead of its aircraft **cannot come back**.
Measured above: the gap grows rather than closing.

This matters more on the web than in the app. `RAF_MOTION = true`, and at `Map.tsx:2388` the poll
path deliberately does **not** set the marker when the store has the flight:

```js
if (!(RAF_MOTION && storeRef.current.has(cs))) markersRef.current[cs].setLatLng([dispLat, dispLon])
```

So the tracker owns the position outright for essentially every airborne flight, while the app —
after the 15 Aug revert — uses it only for predicted ones.

**Not observed in production.** On 15 Aug the web was right and the phone was 190 km out, so real
drift is evidently small, presumably because the elapsed-time seed is usually close and trackers
are rebuilt whenever a flight leaves and re-enters the store. This is a latent defect of unmeasured
frequency, not a live one.

## Constants that agree

| | web | app |
|---|---|---|
| fix staleness | `STALE_FIX_MS = 150 * 1000` | same |
| arrived hold | `ARRIVED_HOLD_MS = 60 * 60 * 1000` | `ARRIVED_HOLD_MIN = 60` |
| marker colours | `MARKER_ACCENT` | identical values |

## Divergences

### 1. The status word on the MAP — «في الجو» against «أقلعت»

Not translation, and not the boards. Both sides define the same strings, and **both boards already
apply the same rule**: on departures an airborne flight is «أقلعت», on arrivals «في الجو».
`app/board/page.tsx:388` and the app's `StatusBadge` argue it identically — on a departures board
the fact you care about is that it has gone.

The maps diverge, and neither applies that rule:

- **web** derives the badge from map state — arrived, signal-lost, projected — so an airborne
  flight always reads «في الجو», with a `~` prefix when projected. It has no path to «أقلعت» at
  all (`Map.tsx:638`).
- **app** shows `PhaseChip` when a live row exists and falls back to `MapStatusBadge` on the
  board's `status`, which renders `Departed` as «أقلعت» — the board's word without the board's
  context. The live row comes from `/v2/live`, which carried one or two flights all evening, so
  the fallback is the common case rather than the rare one.

The web's choice looks right for a map: direction is visible on the screen, so «في الجو» is the
fact being asked for. The app's map badge should follow it — while both boards keep the view rule
they already share.

### 1b. Status canonicalisation — latent

The web's `canonicalStatus` folds `landed` / `land` / `arrived` into `Arrived` before anything
renders. The app's `statusConfig` is a direct key lookup falling back to `Unknown`, with no
equivalent — so a lowercase form would render as Unknown on a card.

Dormant today: flight-api emits only `Scheduled`, `Arrived`, `Expected`, `Departed`, all of which
the app knows. It becomes live the first time a raw FR24 status reaches a client.

### 1c. calcDelay — a NaN the web returns null for

Byte-for-byte the same arithmetic except one guard. The web checks
`if (!Number.isFinite(schedMs)) return null` before the midnight adjustment; the app
(`app/(tabs)/map.tsx:45`) does not, so a malformed `HH:MM` produces `NaN` and a broken chip where
the web shows nothing. Low reachability — the null/empty guard above catches the common cases.

### 2. Countdown source

The web reads `eta_stable_utc`, damped once by flight-api. The app reads it for the arrival **time**
(16 Aug) but its countdown still derives from `actual_dep_utc + stableDuration(duration_min)` — a
second damping, fighting the server's. Task #31.

Why it matters, sampled every 15 s on 15 Aug: FR24 alternated FYC728's arrival between 21:07:12 and
21:09:20 and back inside two minutes. The site held 12:07; the phone read 12:07, 12:09, 12:07.

### 3. Web-only features

- «نقترب من المدرج» inside 10 km — `FINAL_RING_KM`, no equivalent in the app
- Distance still to run — `label.distance_left`, absent from the app's i18n entirely
- Stale-bundle banner — deliberately web-only; a native app updates through the store

### 4. Position sources

The app reads `/api/airspace` for positions **and** `/v2/live` for phase, progress and eta. The web
reads `/api/airspace` and the board. Once flight-api's ADS-B circle merge is proven in production —
deployed 15 Aug, still unexercised because no Syrian flight has been inside the circles since — the
app should return to one document.

## Push alerts — checked, and they agree

Worth stating because the opposite was nearly recorded here. The alert path (`cron/alert-shadow`)
sends LANDED on a real `actual_arr_utc` transition, and only logs `would_send=false` when a status
flips to Arrived with **no arrival timestamp of any kind**.

That reads like a gap — both clients call a flight Arrived from `arr_confirmed_at` alone — and it
is not one. flight-api publishes `actual_arr_utc` as `real_arr or arr_confirmed_at`, so an arrival
the server established itself carries a timestamp and pushes normally. The withheld case is a bare
status change with nothing behind it, which is correctly withheld.

Measured while checking, and worth keeping — arrivals over the seven days to 15 Aug:

| airport | arrivals | FR24 published | we inferred | inferred |
|---|---|---|---|---|
| DAM | 197 | 191 | 6 | 3.0% |
| ALP | 65 | 36 | 29 | **44.6%** |
| DEZ | 1 | 0 | 1 | 100% |

Not a defect — the server fills the gap and everything downstream works. But close to half of
Aleppo's arrival times are ours rather than FR24's, which is the measured reason `arr_confirmed_at`
exists and is directly relevant to how an inferred arrival should report its time there.

## The flight sheet against the web's popup

Compared by which **facts** each renders, not by pixels.

### Time flown, once it has landed — the app shows the wrong number, not a missing one

The web computes `actualArrMs - depMs` and labels it «زمن الرحلة»: the time the flight actually
took. The app's `ArrivalBar` renders `durationLabel(f.duration_min)` — the **scheduled** block
time, and unlabelled. A flight that ran twenty minutes long reports its schedule on the phone.

`label.flown` is defined in the app's i18n and rendered nowhere.

### Absent from the sheet

| | web popup | app sheet |
|---|---|---|
| altitude | yes | yes |
| ground speed | yes (`unit.kt`) | **no** — the string is defined and never rendered |
| distance still to run | yes (`unit.km`) | **no** — the string is not defined at all |

## Not yet compared

The board page, the flight sheet's layout, push notifications, and the news and airlines tabs.
Anything not named above is **unexamined**, not verified equivalent.

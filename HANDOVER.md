# Handover — path-anchored flight tracking

Written 2026-08-02. Continues an audit + rebuild of how FlySyria acquires and displays
live flight positions.

---

## 1. The core finding

> **⚠ LARGELY WRONG — corrected 2026-08-02. Read this before trusting anything below.**
>
> The evidence for this section was gathered against **adsb.fi's v2 `lat/lon/dist`
> endpoint, which is deprecated and answers `200` with an empty `ac` array** — not an
> error. adsb.lol, the fallback, also returns 200-empty over this region, so every call
> reported success while delivering nothing. Measured side by side:
> **v2 IST/250 → 0 aircraft, v3 IST/250 → 88, v3 DAM/250 → 31.**
>
> v3 also caps `dist` at **250 NM**, so the 700 and 400 NM circles below were over the
> limit and could not have worked either. The feeds were never dark; we were asking a dead
> endpoint. A second cause was compounding it: `airlines` mapped `DN → JOC` while the
> aircraft broadcast `DNA541`, so Dan Air flights never matched their live contact at all.
>
> The one claim here that survives is the *design* conclusion — the path-anchored model
> must not depend on continuous fixes. That remains right, and is why nothing visibly
> broke while the feed was silently empty. **Re-measure coverage before planning around
> scarcity.**

**ADS-B delivers nothing for large stretches of time.** Verified repeatedly:

- `/api/airspace` returns `aircraft: []` while flights are visibly airborne
- The visible markers come from `boardDeparted` — schedule rows dead-reckoned along
  `route_paths`, with no live position at all
- `adsb.lol` returns 0 aircraft over Syria, UAE and Istanbul while returning 71 over
  Frankfurt — the volunteer ground network barely covers the region
- `adsb.fi` 403s (Cloudflare) from a home IP; it works from Vercel, but returns empty often
- FR24 *does* see the traffic — it found FYC727 on approach to DXB and 20 aircraft in a
  corridor at a moment when every free feed showed nothing

**Consequence:** you cannot develop or test live tracking on localhost. The dev server's
ADS-B calls are blocked from this machine, so it always shows zero aircraft.

`fetchRadiusFeed` catches its own errors and returns `[]`, so a failing feed is
indistinguishable from empty sky. That is still true and worth fixing.

---

## 2. What was built

### `lib/path-tracker.ts` — the motion model (committed, `9805edf` + `ae4fe5e`)

An aircraft's state is a single scalar `s` — its fraction along the route — advanced by a
rate `v`. **Live fixes never assign position.** They only nudge the rate, within clamps
that keep motion forward and bounded. Therefore:

- a missing fix is a non-event → aircraft cannot vanish
- `s` is monotonic → aircraft cannot reverse
- `v` is clamped → corrections cannot present as jumps

The primary rate signal is **not ADS-B**: it is the arrival estimate.
`v_nominal = remaining distance / remaining time`, recomputed whenever the ETA is revised.
A flight with zero fixes still arrives when the airline says it will. Given section 1,
this is the channel that actually carries most flights.

Other behaviour:
- **Distance-space progress.** Stored `f` is index-proportional while segments range 3 km
  to 500+ km; across the 61 good paths that diverges from true distance-fraction by up to
  15.7% (~200 km on a long route). `PathGeometry` derives cumulative distance at
  construction. Do not "optimise" this by storing it — it would be one more thing to drift.
- **Jamming rejection:** off-path distance, impossible implied ground speed, backward
  hysteresis (needs corroboration), divergence detection. Every rejection is tallied by
  reason for telemetry.
- **Synthesised paths:** routes with no stored corridor get a great circle rather than
  being rejected as `no_path`.
- **Multiple corridors per route** — see section 3.

### `lib/tracker-store.ts` — one tracker per flight (UNCOMMITTED)

Holds a `PathTracker` per callsign. The poll *feeds* it (a fix, a revised ETA) and never
sets marker positions. Position is obtained by asking the store on every animation frame.

### `components/Map.tsx` — rAF renderer (UNCOMMITTED)

Behind `const RAF_MOTION = true`. Six edits: import, flag, refs, feed at the marker-update
site, store reconcile at end of poll, and an rAF loop calling `setLatLng` per frame. The
poll's own `setLatLng` is skipped only for flights the store manages. Set the flag false
and behaviour is exactly as before.

`window.__trackerStore` is exposed for console inspection.

### `scripts/backtest-path-tracker.ts` (committed)

Replays `flight_position_log` through the tracker vs the naive model.

**Results over 36 real flights:** mean max frame-to-frame movement **2.94 km** vs
**906.7 km** naive; **zero** monotonicity violations.

Two methodology traps, both hit and corrected — read the file header before changing it:
- smoothness must be sampled at *display* cadence, not at fix times
- the ETA must not come from the actual landing time (hindsight makes arrival trivially
  correct)

---

## 3. Route path data

`route_paths` now has `variant` in its primary key, plus `observed_count` and
`last_matched_at`. Most routes have one variant.

**IST-DAM has two genuine corridors**, 282 km apart, both flown daily:
- variant 1 — northern via Ankara (THY846; matches a user-supplied FlightAware track to a
  1 km median)
- variant 2 — southwestern diagonal (THY848, SYR446)

The tracker holds a geometry per corridor, projects each fix against all of them, and lets
the evidence choose. A fix matching *any* corridor is legitimate; only one matching *none*
is genuinely off route — which matters because that is the same test doing jamming
rejection.

Corridor choice **locks at 30% progress**, because corridors share endpoints and fan apart
in the middle: switching late means moving the aircraft across the whole gap. Early it
costs tens of km instead of hundreds; the residual is glided over 60 s with a smoothstep.
Late switching measured 36.6 km per frame; with lock + glide, 9.3 km.

### Fixed this session
- ALP-SHJ, DAM-AMS, DAM-MCT were truncated (about half their distance in the final 5%).
  Rebuilt from FR24 at 40 waypoints. All 66 paths now non-degenerate.
- ALP-DUS and DAM-MJI created by reversing their return directions.

### Still open
- BER-DAM, DAM-BER, DAM-MED, MED-DAM have no path. Not yet operating; the synthesised
  great circle covers them when they start.
- `is_validated` is meaningless — it was `true` on all three broken paths. Replace with
  computed metrics (`PathGeometry.degeneracy()`, endpoint error, segment spread).
- `observed_count` was seeded by hand. Nothing increments it yet.

---

## 4. Immediate next step — verify the marker actually moves

The store feed has now been **widened to the schedule overlay** (done 2026-08-02). It was
gated on the ADS-B branch, which per section 1 is usually empty. Schedule-overlay flights
have `actual_dep_utc`, `duration_min` and a route but **no fixes at all** — exactly what
the ETA channel is for. The rAF loop drives `schedMarkersRef` as well as `markersRef`.

**Confirmed working:** with two real flights airborne, the store tracked both from schedule
data alone — FYC362 at s=0.411 moving 1,006 m in 4 s (~905 km/h), SYR443 at s=0.751 moving
778 m in 4 s (~700 km/h). Both `isEstimated: true`, `synthesized: false`, i.e. real stored
route paths with zero live fixes. Speeds are physically plausible.

**NOT confirmed:** that the rendered Leaflet marker visibly moves. At the default zoom the
map spans ~2.3 km per pixel, so several seconds of flight is sub-pixel and the CSS
transform does not change. A 30-second sample would settle it but the browser pane timed
out before it completed.

To finish verification: zoom the map well in, then sample
`document.querySelectorAll('.leaflet-marker-icon')` transforms over ~30 s. They must change
smoothly, not once per 10 s poll. If they do not change at all while
`__trackerStore.callsigns()` is non-empty and `s` is advancing, the fault is in the rAF
loop or in `setLatLng` being overwritten elsewhere — not in the model.

---

## 5. Other open items

| Item | Notes |
|---|---|
| **NEXT: `/api/airspace` must resolve callsigns from `flight_lookup`, and a cron should populate it** | `flight_lookup` already maps **per flight** `iata_number → broadcast_callsign` (154 rows, 152 populated, `source: fr24`) and had `DN541 → DNA541` correct all along. `/api/schedule`, `route-reconcile`, the admin routes and the damairport sync all read it — **`/api/airspace` does not**. It derives the callsign algorithmically instead: `toCallsign('DN541') = iataToIcao['DN'] + '541'`. That assumption breaks for codeshares, wet-leases, or any flight whose broadcast callsign is not `<airline ICAO><same number>`. Fix: resolve from `flight_lookup` first (cached like `fetchIataToIcao`), fall back to `toCallsign()` only for flights absent from it. Also unused by the map: `flight_lookup.fr24_uses_callsign` (true for XH486, false for the rest) which encodes whether FR24's `num` is already the broadcast callsign. Then add a cron to keep the table populated for new flights. |
| **A wrong IATA→ICAO mapping fails silently and completely** | Found 2026-08-02 by the user, not by any check. `airlines` had `DN → JOC`; the aircraft broadcasts `DNA541`. So `boardMap.get('JOC541')` never matched, `board_match` stayed false, and every Dan Air flight ran on schedule data alone — **for at least two weeks** (DNA542 sits in `aircraft_last_seen` from 22 July). Nothing errors; it is indistinguishable from "no ADS-B coverage", which is exactly the wrong conclusion I drew for hours. Patched `airlines.icao` to `DNA` — note the joined `airlines` row already read DNA, so the two tables disagreed. **Standing check, run it periodically:** for each airline on the board, does its mapped ICAO prefix ever appear in `aircraft_last_seen`? DN → JOC scored **0 in 14 days** while every other airline scored 2–381. That query would have caught this the first day Dan Air flew. |
| **adsb.fi v2 was deprecated and returning 200-with-empty** | Fixed 2026-08-02 — the single most consequential find of the session. v2 `lat/lon/dist` answers `200` with an empty `ac` array, not an error, and adsb.lol (the fallback) also returns 200-empty over this region, so `fetchRadiusFeed` reported ok on every call while receiving nothing. Measured: v2 IST/250 → 0 aircraft, **v3 IST/250 → 88**, v3 DAM/250 → 31. v3 caps `dist` at **250 NM** (400 → HTTP 400) and the public rate limit is **1 req/s**, so the circles are queried sequentially with a 1.1 s gap. The old 700/400/400 NM radii were over the cap and could never have worked. **This means the handover's opening claim — "ADS-B delivers nothing for large stretches of time" — needs re-testing; a good part of it was this.** |
| Feed coverage gaps at 250 NM | Circles are now DAM, Gulf, IST and central Anatolia (added to close the IST–DAM corridor gap, which is exactly where the two variants fan apart). **KWI, RUH and JED are uncovered** and they are top-10 routes (26, 20 and 12 flights/30 d). Two more circles fix it — one at ~27.1 N/47.3 E covers RUH *and* KWI, plus one on JED — but at 1 req/s each circle adds ~1.1 s to a cache miss, so 6 circles = ~6.6 s. Regions are free in credits and expensive in latency **only because polling sits on the request path**; move it to a cron and 8 circles every 15–30 s is nothing. |
| Departure inference | Fixed 2026-08-02 (`dd04e78`). `/api/airspace` synthesised `actual_dep_utc = sched_dep` for a board flight first seen airborne, drawing a delayed flight as far along the route as the delay, then snapping back when fr24-sync published the truth. Now derived from position: `now − progress × block_time`, round-tripped to within ~1 min. **It no longer writes a fabricated `real_dep` into `fr24_daily_cache`.** |
| `middleware.ts` fails open | `ADMIN_USERNAME`/`ADMIN_PASSWORD` default to `admin`/`changeme` when unset. Production sets them, but any deploy without them exposes `/admin/*` and `/api/admin/*` on a known default. Should fail closed. |
| `/api/debug-live` is unauthenticated in production | Untracked file, so it ships with the working tree. Spends ~53 FR24 credits per call, no auth, no rate limit, and echoes the upstream URL. Delete it or put it behind `CRON_SECRET`. |
| **OpenSky blocks Vercel at the IP level — the poller cannot run there** | Measured 2026-08-02 from a production function. Control host `api.adsb.lol` → HTTP 200 in 347 ms. `opensky-network.org` and `auth.opensky-network.org` → connection failure after 10.5 s. Both OpenSky names resolve to the **same** IPv4 address (`194.209.200.34`, no AAAA), so it is one server, and the same request from a home connection returns in 0.43 s. Packets dropped, not refused. **This reverses section 5's claim that "OpenSky does not block Vercel"** — the original browser-side call was right about the block and wrong only about the workaround (CORS). Consequence: `lib/opensky.ts` and `/api/cron/opensky-poll` are correct but can never succeed on Vercel. They need an egress IP OpenSky accepts. Test any candidate host before committing to it — Railway is also datacenter space and may be blocked too. Because the poller only writes to Supabase and `fetchLoggedPositions` only reads from it, the poller can move hosts with **no change to the frontend**. |
| ~~Vercel Hobby throttles every cron to once a day~~ | **Wrong — retracted.** The project is owned by team `wassimhamwi-7070s-projects`, which is **Pro**; the Hobby reading came from `/v2/user` (the personal account), which does not own this project. Crons do run at their configured frequency: `fr24-sync` fired at 00:03 against `0 */2`. The once-a-day `fr24_daily_cache.fetched_at` pattern predates the upgrade. Check plan via `/v2/teams`, not `/v2/user`. |
| Vercel cost is builds, not runtime | Billing cycle Jul 17–Aug 2: Build CPU Minutes **$19.68 of $28.48 (69%)**, Observability Events $4.78, and all function runtime **$4.02** combined. Cause: **1,416 production deploys of this project in 16 days (~92/day)** — 952 CLI plus 458 from the Git integration building the same commits again. Moving the backend off Vercel would save ~$4/mo and is not a cost lever; deploy frequency and the duplicate Git integration are. |
| ~~Vercel Hobby throttles every cron to once a day~~ (superseded) | Measured 2026-08-02, and it invalidates a lot of assumptions in this repo. Hobby's minimum cron interval is **once per day** with ±59 min precision, regardless of the expression in `vercel.json`. `fr24_daily_cache.fetched_at` proves it: `fr24-sync` is configured `0 */2` (12×/day) and ran exactly once a day at ~20:00 UTC on Jul 30, 31 and Aug 1. So `landing-confirm` (`*/15`) and `opensky-poll` (`*/2`) are on one run a day too. **The "frozen daily cache" that `ACTIVE_KEYWORDS` works around is this, not an FR24 quirk** — the cache is stale because nothing refreshes it, so flights read "Estimated dep" all day. Do not add or tune a frequent cron before confirming the plan; check with `curl -s https://api.vercel.com/v9/projects/flighttracker-sy -H "Authorization: Bearer $TOKEN"` and read `crons.definitions`, and `/v2/user` for `billing.plan`. |
| ~~OpenSky is broken two ways~~ | **Done 2026-08-02.** The browser-side call and `/api/opensky-hexes` are deleted; OAuth2 client credentials replace Basic auth (`lib/opensky.ts`); the poll is scheduled `*/2 * * * *`. **Blocked on credentials**: `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET` must be created on the OpenSky account API tab and added to Vercel — until then the route 503s. `OPENSKY_USER`/`OPENSKY_PASS` are dead and still in Vercel. |
| ~~Poller restructure~~ | **Done 2026-08-02.** Poller fixes reach the map via a `flight_position_log` read (`fetchLoggedPositions`). The per-callsign and per-hex adsb.fi fan-outs are **deleted**: they issued one request per flight, 3 at a time with 300 ms sleeps (~53 callsigns/day, since `ACTIVE_KEYWORDS` matched `'estimated'` and the daily cache stays "Estimated dep" all day). Measured ~10 s per cache miss against an empty sky; measured yield 4 aircraft in 7 days. `/api/airspace` now makes exactly 3 upstream ADS-B calls — one per circle, in parallel. Typical cache miss 0.7–1.8 s. |
| Remaining `/api/airspace` latency | Worst case is now a single circle's 8 s `AbortSignal.timeout` when adsb.lol stalls (observed 8.65 s). The three circles run in parallel so it does not compound, but 8 s is long for a per-visitor path — consider dropping it to ~3 s. |
| Europe has no live fix source until OpenSky runs | The deleted hex/callsign loops were the only channel reaching outside the circles (they caught SYR272 over Schiphol). Europe is ~12 flights/30 days and is carried by the path-anchored ETA channel meanwhile, which is the documented normal case. `fetchLoggedPositions` picks it up the moment the OpenSky cron has credentials. |
| OpenSky bbox sweep | The Syria+neighbours bounding-box query writes nothing — `writeState` persists only aircraft present in our hex list, and discards the rest. It cost 3 of the 4 credits per poll. Now off by default; `OPENSKY_BBOX_POLL=1` re-enables it. Give it a consumer (an OpenSky-backed "Over Syria" view) before turning it back on. |
| `import-route-path` | Still overwrites the final waypoint with the airport, which can only manufacture geometry. Should append, and should add a *new variant* when a track disagrees with every stored corridor rather than overwriting one. |
| RLS | Disabled on 13 tables; anon key can read *and write* `route_master`, `airports`, the caches. Deliberately deferred by the user to a hardening pass. **Live writes use the anon key**, so enabling RLS without switching those to the service key will take tracking down. |
| ~~Empty-feed handling~~ | **Done 2026-08-02.** `fetchRadiusFeed` returns `{ok, aircraft}`, so a dead feed is no longer indistinguishable from quiet sky; `feeds_live: false` in the response means every circle failed. The DB fallback was doubly broken — it could never fire (nothing threw, because `fetchRadiusFeed` swallowed its own errors), and it discarded its own output (`board_match` hardcoded `false`, which the client filters on). Both fixed and verified by pointing the feeds at a dead port: 3 board flights came back stale, enriched and `board_match: true`. |
| Radius feeds are in **nautical miles** | `dist` is nm, not km — a dist=250 probe returned aircraft out to 233 nm (431 km). The Syria circle is 1,296 km, not 700. A Turkey circle (IST, 400 nm) was added 2026-08-02: over 48 h `aircraft_last_seen` held 1,409 aircraft in the 650–700 nm ring and 8 past it, a cliff at the query boundary rather than at the edge of coverage. It closes Thrace/Edirne and reaches Sofia and Athens. **Europe is still uncovered** — ALP–DUS and DAM–AMS run ~1,080 nm out from IST. Now that non-board aircraft are filtered out of the response, a wider circle costs upstream time but not client bandwidth, so extending it is cheap if those routes need it. |
| Marker heading ("flying sideways") | **Fixed 2026-08-02.** The rAF loop set `setLatLng` per frame but never touched the icon, so position came from the tracker's progress scalar while rotation came from the poll's `fPos` (clamped to 0.97) every 10 s. When the two estimators drift, the nose points somewhere the aircraft isn't going — measured on FYC362 at 81.8° when the true path bearing was 138.9°. Worst on turning routes: MJI–DAM swings 84°→184° inside its last 15%. The loop now writes `p.track_deg` onto the existing `<svg>` (no `setIcon`, no DOM rebuild). Intermittent by nature — both surfaces looked correct an hour later, so don't treat "it looks fine now" as evidence it is fixed. |
| Cross-midnight day assignment is the recurring trap | `/api/flightboard` assigns a flight to a Syria calendar day (UTC+3) while FR24 stores it by arrival date, so every late-evening inbound needs an explicit rule. There are now four passes doing this: the main day-window filter, prev-day overflow, next-day Case A (early landing), next-day Case B (still airborne). **Case B shipped with its airborne condition in the comment but not in the code**, so any flight landing within 4 h of Syria midnight appeared on today's board from 00:00 — FYC490 SAW→DAM showed as "Scheduled" 19 h before departure while also sitting correctly on tomorrow's. Fixed 2026-08-02. When touching these passes, check both days of the boundary, and check a flight that has *not* departed as well as one that has. |
| Geometry duplication | `interpolatePath`, `bearingFromPath`, `slerpGreatCircle` exist in both `lib/flight-predictor.ts` and `components/Map.tsx`. |
| `tsconfig.tsbuildinfo` | Tracked build artifact; should be gitignored. |

---

## 6. Credits and costs

FR24 charges **6 credits per aircraft returned** (per result, not per request; 1-credit
floor). Tracks are **40 credits** each. Balance was ~55,000 after ~730 spent this session.

At 13 concurrent flights a `callsigns=` batch is 78 credits — 172,800/day at 1-minute
polling, which is impossible; ~7,500/day at 15 minutes, which fits the 660k plan. The
path-anchored model is what makes that affordable, since it corrects a rate rather than
chasing a position.

OpenSky charges **per call, not per aircraft** — an `icao24` batch is 1 credit regardless
of size, so its free 4,000/day is worth more than it looks. A bounding box costs by area:
≤25 sq° = 1, ≤100 = 2, ≤400 = 3, larger or global = 4. The Syria box is 12° × 21° = 252 sq°,
so 3 credits.

At `*/2` with the bbox off that is 720 credits/day against a 4,000 free tier; with the bbox
on it would be 2,880, which still fits. Auth is OAuth2 client credentials — 30-minute
bearer tokens from
`https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`.
Basic auth is no longer accepted at all. `icao24` must be **repeated once per address**
(`?icao24=a&icao24=b`), not comma-joined. All of this lives in `lib/opensky.ts`.
`OPENSKY_USER`/`OPENSKY_PASS` are dead and should be removed from Vercel.

---

## 7. Mistakes made here — do not repeat

1. **I replaced a correct route path.** Two flights disagreed with stored IST-DAM, so I
   concluded the path was wrong and overwrote it. It was right; the route simply has two
   corridors. A route derived from N agreeing instances is still only evidence about those
   N. Before replacing a path, require that the new track disagrees with the stored one
   *and* the stored one disagrees with everything.
2. **I broke a live endpoint as a migration side effect.** Widening the `route_paths`
   primary key made `/api/routes` return two rows for one OD; `Map.tsx` keys by OD alone,
   so a corridor was silently overwritten in production. Widening a key changes every
   query that assumed uniqueness.
3. **I theorised twice about the truncated paths and was wrong both times** (ETA-overrun
   rate spike; cascading >200 nm gap filter). Measurement killed both. The historical cause
   is still unknown — `buildWaypoints` samples correctly by distance.
4. **Test helpers must use the real geometry.** Several early test failures came from
   assuming paths interpolate linearly in lat/lon; they follow great circles.

---

## 8. Commands

```bash
npm test                                     # 93 tests
npx tsc --noEmit                             # clean
node --experimental-strip-types --env-file=.env.local scripts/backtest-path-tracker.ts
```

Deploys are CLI-based and ship the **working tree**, not git HEAD:

```bash
vercel deploy --prod --cwd /Users/wassim/FlightTracker
```

Uncommitted work therefore goes live on every deploy. Currently uncommitted:
`lib/tracker-store.ts`, `lib/tracker-store.test.ts`, `components/Map.tsx`, and the
untracked FR24 debug endpoints (`app/api/debug-live/`, `app/api/debug-summary/`), which the
user chose to leave out of git.

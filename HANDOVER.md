# Handover — path-anchored flight tracking

Written 2026-08-02. Continues an audit + rebuild of how FlySyria acquires and displays
live flight positions.

---

## 1. The core finding

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
| Poller restructure | `/api/airspace` still fetches upstream per user request; load scales with visitors, not aircraft. `/api/cron/opensky-poll` exists but is **not scheduled** and uses HTTP Basic auth, which OpenSky no longer accepts (OAuth2 client credentials only). |
| `import-route-path` | Still overwrites the final waypoint with the airport, which can only manufacture geometry. Should append, and should add a *new variant* when a track disagrees with every stored corridor rather than overwriting one. |
| RLS | Disabled on 13 tables; anon key can read *and write* `route_master`, `airports`, the caches. Deliberately deferred by the user to a hardening pass. **Live writes use the anon key**, so enabling RLS without switching those to the service key will take tracking down. |
| Empty-feed handling | `/api/airspace` returning zero should not clear the map, and failure should be distinguishable from empty sky. |
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
of size, so its free 4,000/day is worth more than it looks. Credentials are in Vercel;
`OPENSKY_USER`/`OPENSKY_PASS` are dead and should be removed.

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

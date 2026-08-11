# Flight data: the shape it should be

Status: design, agreed 11 Aug 2026. No code written against it yet.

## What is wrong today

`fr24_daily_cache` holds one row per airport per day with two JSON arrays inside it. That is not
a schema, and the consequences are structural rather than cosmetic:

- **Fourteen files touch it. Nine of them write.** There is no owner. `/api/fr24-cache` merges
  with `statusRank`; `/api/flightboard` merges again across airports and dates; `carry-over` has
  its own rules; the browser normalises before any of them see it. Four sets of merge logic for
  one dataset.
- **No per-flight identity**, so nothing can be said about a single flight over time. "When did
  RJ434's departure reach us?" was answerable only to within eleven minutes, because the only
  timestamp is `fetched_at` on the whole airport row, rewritten wholesale each time.
- **The blob generates its own maintenance.** `carry-over` exists to chase flights that aged out
  of the FR24 window; `landing-confirm` to patch arrivals nobody recorded; `route-reconcile` to
  re-derive schedule drift from blobs. Those are not features, they are compensation.

Adding the Railway harvester as a tenth writer would make this worse. The fix is a shape with an
owner.

## The shape

### One canonical row per flight per operating day

Identity is the flight — number, operating date, origin, destination. The airport whose feed
observed it is **provenance, not identity**.

Per-source observations stay in `fr24_staging_flight`, keyed by observing airport. The
disagreement between what Damascus reports and what Dubai reports is diagnostic and worth
keeping, but it is not something the board should ever have to reconcile at read time.

### One writer

The Railway worker. Everything else reads. No browser writes, no merge logic in API routes.

### Invariants in the database, not in call sites

Already built and proven in the staging trigger:

- an actual departure or arrival is never unlearned — an event that happened does not un-happen
  because the feed stopped mentioning it;
- a definitive status never regresses, ranked by the same table `/api/fr24-cache` uses today;
- every field records **when it was learned**, not only what it is.

### A null means "we stopped being told", not "it is gone"

The sharpest rule, and the one that shapes the read path. When FR24 returns no estimated arrival
it may mean the flight has landed and the estimate is properly retired, or it may mean the feed
dropped it. Those are different facts.

So: **keep the last known value and its timestamp; decide at read time whether it is still worth
serving.** A retired estimate on a landed flight is correct to drop. A stale estimate on a flight
still in the air is a warning. Storage records; the query decides.

### An append-only event log

`flight_event` — one row per field transition: flight, field, old value, new value, observed at,
source.

Not needed to serve the board. Argued for on one ground: an event log can be ignored, and it
cannot be backfilled. Two uses are already queued — scoring FR24's estimates against what
actually happened ([[project_live_rate_eta]]), and answering how far an estimate wanders before
it settles. Write-only and cheap.

## The read path

`/api/flightboard` returns **byte-identical JSON** to what it returns today. Web and mobile
change nothing. Its insides become a select with a filter instead of reconstructing flights from
blobs.

This is the whole reason the cutover is safe: the contract is frozen, so a diff between old and
new responses is a complete test.

## What the contract does not yet expose

The normalised table carries fields the current response has no place for. Not part of this
change — recorded so the app-side work can be planned separately:

| available | today |
|---|---|
| `dep_terminal`, `dep_gate` | not in the board response |
| `arr_terminal`, `arr_gate`, `arr_baggage` | sheet only, via a separate lookup |
| `est_dep`, `est_arr` with `*_seen_at` | value only, no age |
| provenance — which airport's feed saw it | absent |
| per-field learned-at timestamps | absent |

The interesting one is age. "Estimated 21:33, learned four minutes ago" is a different statement
from "Estimated 21:33, learned an hour ago", and the app currently cannot tell them apart.

## Migration: one file at a time

The two pipelines stay independent. No dual-write, no coexistence logic.

1. The worker writes the canonical table. `fr24_daily_cache` carries on exactly as today, still
   fed by the browser and the existing crons. Nothing is switched off.
2. Readers move across **one file at a time**, each diffed against the old path before the next.
   `/api/flightboard` first — it is the live path for both clients and the strictest test.
   `/api/airspace` second. The analytic consumers (`stats`, `weekly-stats`, `destinations`,
   `flight`) follow.
3. When the last reader has left, delete the writers: `warmFR24Cache` in `app/board/page.tsx`,
   `/api/fr24-cache`, `fr24-sync`.
4. Re-examine `carry-over`, `landing-confirm` and `route-reconcile`. Most of what they do exists
   to compensate for the blob and should disappear rather than be ported.
5. Drop `fr24_daily_cache` last.

## Open questions

- **Reconciling two observations into one canonical row.** When Damascus and Dubai disagree,
  which wins? Proposal: the airport nearer the event — origin for departure fields, destination
  for arrival fields — since that is where the information originates. Needs checking against a
  day of staging data before it is fixed in code.
- **Retention.** The canonical table grows without bound. Daily flights are small, but a
  retention rule should exist before it is serving traffic rather than after.

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

## A worked example: RB445, 10 Aug 2026

Aleppo to Istanbul, scheduled 19:30Z. FR24's own website records it departing 20:28Z and landing
22:02Z, on YK-SYR. Three separate failures of the current pipeline, on one flight:

**We asserted the opposite of what we knew.** The harvester recorded the departure at 20:35:05Z.
The `no-activity` inventory ran at **21:15:35Z** — forty minutes later — and flagged the flight as
having done nothing. The information was public, and held, before the claim was made.

**A wrong answer stood for twelve hours.** Flagging runs at 21:15Z and reconciliation at 09:00Z,
so the row stayed open long after the board itself was showing the flight as landed. Resolution
is a batch job against data that changes continuously.

**The cache holds a departure time that is wrong and cannot be corrected.** It has `real_dep` at
19:54Z against FR24's own 20:28Z — 34 minutes early. Its merge keeps the existing row once an
arrival is confirmed, so an error captured early is frozen permanently. Never-downgrade without
never-correct.

The staging trigger refuses nulls but accepts revisions, which is why it agrees with FR24 to the
second.

None of this was diagnosable before. The cache has one `fetched_at` for a whole airport-day, so
"when did we learn this flight had departed" had no answer; the per-field `*_seen_at` columns are
what turned an argument about architecture into a timeline. That is the case for the backend pull
in one row, and it is why validating an *absence* of data — see `outcome` below — has to be
deliberate rather than inferred.

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
- every field records **when it was learned**, not only what it is.

There is deliberately no status rule here. `status` is not stored — see the reconciliation
measurement below — so there is nothing to rank.

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
| status derived per viewpoint (origin or destination) | one string, whichever was stored |
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

## Retention: a live table of three days, and a history table that earns its keep

The canonical table holds **five days**. A nightly job compacts anything older into
`flight_history` and clears it.

Five rather than three deliberately: this data has never existed before, so the working window is
set wide enough to find out what a few days of live history is worth before it is narrowed. It
costs almost nothing — ninety flights a day — and the answer decides the number.

**`flight_history` is the product, not the archive.** It holds the final facts about a flight:
what was scheduled, what actually happened, and whether it happened at all. Everything in the live
table is working state on its way to becoming one settled row.

That keeps the serving table small enough that every query against it is trivial, and it gives
history a job rather than making it an archive:

- it becomes the source for `/api/stats` and the daily figures, instead of those being derived
  from a cache that was never meant to be durable;
- it can answer questions the live table structurally cannot — **flights that were scheduled and
  never took off**, routes that quietly stopped, an airline's punctuality over a season.

Compaction is the moment to collapse the chronological record: the live table carries every field
and its learned-at timestamps while a flight is current, and history keeps the settled outcome
plus whatever of the sequence is worth preserving.

## Reconciliation: measured, and it is not the problem it looked like

Measured 11 Aug 2026 on 28 flights seen from both a Syrian airport and the other endpoint
(DXB, SHJ, AMM, KWI):

| field | both | only dest | only Syria | differ |
|---|---|---|---|---|
| `status` | 28 | 0 | 0 | **27** |
| `est_arr` | 5 | 0 | 0 | 1 |
| `real_dep` | 27 | 0 | 0 | **0** |
| `real_arr` | 22 | 0 | 1 | **0** |
| `dep_gate` | 8 | 0 | 0 | 0 |
| `arr_gate` | 5 | 0 | 0 | 0 |

**The timestamps agree exactly.** Zero disagreements on actual departure across 27 flights, zero
on actual arrival across 22. There is no reconciliation problem for the data that matters, and
no need for a rule about which airport wins.

**`status` disagrees almost every time, and none of it is disagreement:**

```
G9352   SHJ = "Landed 15:38"     SYR = "Departed 11:33"
G9433   SHJ = "Departed 04:27"   SYR = "Landed 06:12"
FYC728  DXB = "Departed 19:58"   SYR = "Landed 21:37"
```

Each airport reports the flight relative to **its own role, in its own local time**. G9352 left
Damascus at 11:33 local and landed in Sharjah at 15:38 local. Both are correct; they are two
views of one flight.

### So `status` is not stored

It is a rendering of the timestamps from a chosen viewpoint, not a fact about the flight. The
canonical table stores the times; status is derived at read time for whichever end the caller
cares about — which is what the board already does with `STATUS_KEY`.

This removes `statusRank` along with it. That function exists to referee between conflicting
status strings, and the conflict is an artefact of storing a rendering. Note the never-downgrade
invariant still applies to the **timestamps** — an actual arrival is never unlearned — it simply
no longer needs a status ranking to express it.

### The destination harvest is not worth the requests

`only dest` is zero on every field: Dubai, Sharjah, Amman and Kuwait contributed nothing the
Syrian side did not already have. Combined with the rate limit and the page-as-time-window
problem, destination harvesting should stay off unless a specific field is shown to need it.

**Caveats.** 28 flights at one moment. Gate and terminal counts are small (4-8) and there was no
baggage data at all, so this settles status and timestamps, not gates. Worth re-running over a
full day before the gate fields are relied on.

## Draft table definitions

Not applied. Three questions worth checking before they are — listed after the DDL.

### `flight` — canonical, live

Holds yesterday, today and tomorrow. One row per flight per operating day.

```sql
create table flight (
  -- Identity. Resolved by the worker via flight_lookup before writing, so a flight filed as
  -- FYC781 by one source and XH781 by another lands on one row rather than two. This is the
  -- riskiest column in the schema: see question 1.
  flight_date     date        not null,
  iata_number     text        not null,
  dep_iata        text        not null,
  arr_iata        text        not null,

  callsign        text,                    -- the other identifier, always carried
  fr24_id         text,                    -- FR24's per-leg id; null until it tracks the flight
  airline_iata    text,
  aircraft_type   text,
  registration    text,

  -- Times. The canonical facts; measured to agree across sources.
  sched_dep       timestamptz not null,
  sched_arr       timestamptz not null,
  est_dep         timestamptz,
  est_arr         timestamptz,
  real_dep        timestamptz,
  real_arr        timestamptz,

  -- When we learned the value currently held, not when it happened. Only on the volatile
  -- fields; everything else is reconstructable from flight_event.
  est_dep_seen_at  timestamptz,
  est_arr_seen_at  timestamptz,
  real_dep_seen_at timestamptz,
  real_arr_seen_at timestamptz,

  -- Facts that are not timestamps and therefore cannot be derived. A cancelled flight has no
  -- departure to record, so its cancellation has to be stored — as an outcome rather than its
  -- own boolean, or there would be two ways to say the same thing.
  diverted_to     text,

  dep_terminal    text,
  dep_gate        text,
  arr_terminal    text,
  arr_gate        text,
  arr_baggage     text,

  -- Which feeds have reported this flight. Diagnostic only: the timestamps agree, so there is
  -- nothing to reconcile, but knowing DAM saw it and DXB did not is worth keeping.
  sources         text[]      not null default '{}',

  first_seen_at   timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  primary key (flight_date, iata_number, dep_iata, arr_iata)
);

create index on flight (flight_date, dep_iata);
create index on flight (flight_date, arr_iata);
create index on flight (fr24_id) where fr24_id is not null;
```

**No `status` column.** It is derived at read time from the times, `outcome` and `diverted_to`,
for whichever end the caller is looking from.

`outcome` is not only a compaction concern: it moves to `departed` the moment a real departure
arrives and to `cancelled` the moment FR24 says so. Compaction inherits it and only has to
resolve what is still `unknown`.

### `flight_event` — append-only

```sql
create table flight_event (
  id            bigserial   primary key,
  flight_date   date        not null,
  iata_number   text        not null,
  dep_iata      text        not null,
  arr_iata      text        not null,
  field         text        not null,     -- 'est_arr', 'arr_gate', 'cancelled', …
  old_value     text,
  new_value     text,
  source        text        not null,     -- which feed reported the change
  observed_at   timestamptz not null default now()
);

create index on flight_event (flight_date, iata_number, observed_at);
create index on flight_event (field, observed_at desc);
```

Values as text: this is a log, not a working set, and one column beats six nullable typed ones.

### `flight_history` — compacted

```sql
create table flight_history (
  flight_date     date        not null,
  iata_number     text        not null,
  dep_iata        text        not null,
  arr_iata        text        not null,
  callsign        text,
  airline_iata    text,
  aircraft_type   text,
  registration    text,
  sched_dep       timestamptz not null,
  sched_arr       timestamptz not null,
  real_dep        timestamptz,
  real_arr        timestamptz,
  diverted_to     text,
  outcome         text        not null,   -- departed | cancelled | no_show | unknown
  outcome_source  text,
  -- Derived once at compaction so the stats path never recomputes them.
  dep_delay_min   int,
  arr_delay_min   int,
  -- What became of it. 'unknown' is a first-class value: absence of data is not evidence that
  -- a flight did not fly, and recording our own blind spots as facts would poison the stats
  -- built on this table.
  --   departed  — we hold a real departure
  --   cancelled — FR24 said so
  --   no_show   — scheduled, no departure, and CONFIRMED against the paid API
  --   unknown   — no data, not yet verified
  outcome         text        not null default 'unknown'
                  check (outcome in ('departed','cancelled','no_show','unknown')),
  outcome_checked_at timestamptz,        -- when the paid API was asked
  outcome_source     text,               -- what answered
  compacted_at    timestamptz not null default now(),
  primary key (flight_date, iata_number, dep_iata, arr_iata)
);

create index on flight_history (flight_date);
create index on flight_history (airline_iata, flight_date);
```

Estimates and their learned-at timestamps are dropped at compaction — they are working state.
The sequence they described survives in `flight_event` for as long as that is retained.

### Three questions before this is applied

1. ~~**Identity.**~~ **Answered.** Resolution comes from `airlines`, not `flight_lookup`. The
   table carries both codes an airline has — `iata` and `icao` — and all 20 rows have both,
   because it is maintained by hand once per airline joining the Syrian scheme. So `FYC781`
   resolves to `XH781` through `airlines.icao = 'FYC' → iata = 'XH'`, from a source that is
   complete by construction rather than sparse like `flight_lookup`.

   This also supplies the **legitimacy rule**: a flight is only real if its callsign prefix
   belongs to a known airline. FR24 emits codeshares that look like flights and are not, and
   membership of `airlines` is the filter — which is what `/api/flightboard` already does when it
   rejects Taquan Air's `K3…`. **The harvester does not apply it yet**, which is why `K3965` and
   `K3967` reached staging on 10 Aug.

   Two consequences for the code:

   - `PREFIX_TO_IATA` is hardcoded in `app/api/flight/route.ts` and `app/api/weekly-stats/route.ts`,
     duplicating a column that already exists — and the two copies have already drifted, one
     carrying `SXS: 'XQ'` and the other not. Both should read `airlines`.
   - Those maps hold two entries the table does not: `HST → RB`, a legacy ICAO for Syrian Air,
     and `SXS → XQ` for SunExpress, which is not a known airline and would be rejected anyway.
     `HST` needs somewhere to live — an alias column on `airlines` rather than a constant in two
     route files.

2. **How much of the sequence history keeps.** Right now compaction keeps the outcome and drops
   the estimates. If "how far did the estimate wander" turns out to matter for the ETA work, that
   belongs in history rather than in an event log that is itself being pruned.

3. ~~**`never_departed` needs a rule.**~~ **Answered, and it is not a rule about time.**

   The threshold question dissolved once the data was examined. FR24's own vocabulary already
   distinguishes the cases: a flight still ahead of its slot reads `Scheduled`, and one that has
   passed it without operating flips to `Unknown`. That is FR24 saying it has stopped expecting
   the flight — better evidence than any elapsed-hours rule we could pick, and it arrives at the
   moment FR24 forms the view rather than at a clock tick of ours.

   | observed | `outcome` |
   |---|---|
   | `real_dep` present | `departed` |
   | status contains Cancelled | `cancelled` |
   | past slot, no departure, status `Unknown` | `unknown` → verify → `no_show` |
   | status `Scheduled`, slot in the future | not a candidate |

   **`Unknown` is a candidate, not proof.** On 10 Aug `G9376` read `Unknown` at Sharjah while
   Damascus had it as `Departed 14:15` — one feed losing track of a flight that was airborne. So
   the verification step stands: the paid API confirms a negative for the handful of genuinely
   ambiguous flights, which is the one thing the free feed structurally cannot do.

   Worked both ways on 10 Aug. `FYC761` (ALP-SHJ, 06:35Z) and its return `FYC762` (01:30Z) both
   read `Unknown` with no departure, and both genuinely did not operate — confirmed independently.
   The pair resumed the next morning, `FYC762` departing at 01:49Z. Meanwhile `RB445` had a real
   departure recorded and should never have been a candidate at all.

   **A note on why we can see this.** `FYC761`'s slot was ten hours before the harvester started,
   and it is only in the table because of the `page=-1` fetch. Without the earlier page the new
   system would be blind to exactly the flights it exists to catch — the ones that quietly did not
   happen.

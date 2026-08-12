# Flight contract — additive fields

Draft, 12 Aug 2026. Extends the 24-field payload served by `/api/flightboard` and
`/api/fr24-cache`. **Every field here is additive.** Nothing existing changes name, type or
meaning, so a client built against the current contract keeps working untouched — which matters
because mobile users do not update on our schedule.

The purpose is one sentence: **anything a user can see is computed once, on the server.** The
card, the marker and the popup disagreed on 12 Aug because three places each derived their own
answer from data fetched at three different times. Fields below exist so that no surface
calculates anything a user reads.

---

## 1. Envelope

| field | type | notes |
|---|---|---|
| `as_of` | ISO 8601 | when this snapshot was assembled |

Without it, a surface cannot say how stale it is, and we cannot tell a genuine disagreement
between two surfaces from a timing one. That was the unanswerable question on 12 Aug.

---

## 2. State

| field | type | notes |
|---|---|---|
| `phase` | string key | see vocabulary below; `null` when undetermined |
| `phase_since` | ISO 8601 \| null | when the current phase began |

`phase_since` is what lets a card say "stationary 12 min" without the client tracking history.

### Vocabulary

Keys, not labels. The client owns the strings, because the Arabic will be tuned once real users
see it and we should not need a deploy to change a word.

| key | English | العربية | trigger | needs a fix |
|---|---|---|---|---|
| `scheduled` | Scheduled | مجدولة | no actual departure | no |
| `taxiing` | Taxiing | في الطريق للإقلاع | on ground, moving, before departure | **yes** |
| `departed` | Departed | أقلعت | actual departure recorded | no |
| `en_route` | En route | في الطريق | airborne | no |
| `landed` | Landed | هبطت | actual arrival recorded | no |
| `taxi_to_gate` | Taxi to gate | في الطريق إلى البوابة | on ground, moving, after arrival | **yes** |
| `at_gate` | At the gate | على البوابة | on ground, stopped, after arrival | **yes** |
| `bags_on_belt` | Bags on belt N | الأمتعة على السير N | `arr_baggage` published | no |
| `cancelled` | Cancelled | ملغاة | cancellation reported | no |

Arabic is feminine throughout, agreeing with الرحلة. Belt and gate numbers stay Western
numerals, matching terminal signage.

**Deliberately excluded.** `boarding` and `final_call` need an airline departure-control feed we
do not have. Inferring them from the inbound leg's arrival was measured and rejected: only 41.7%
of departures can be linked to an inbound at all, the average turnaround is 88 minutes, and only
7 of 73 recent legs were in the live window. Announcing a final call we inferred would be the
worst version of the guess, because it is the one state a passenger physically runs for.
`diverted` is defined in the database but has never been observed; leave it unused.

### Rules

**Unknown `phase` falls back to `status`.** A client that does not recognise a value must render
`status`, which it already handles. This is what lets us add a phase later without breaking
shipped builds.

**Phase never claims more than the position supports.** The three phases marked *needs a fix*
are only emitted when a live position confirms them. Without one, the flight stays at the coarser
`departed` / `en_route` / `landed`. The user never sees the words "estimated" or "untracked" —
the state simply gets less specific, which reads as normal rather than as a caveat.

This is the rule that prevents the failure we named: a marker projected over Jordan while the
card reads "Taxi to gate". Phase and position derive from the same fix, so they cannot disagree.

---

## 3. Computed for coherence

| field | type | notes |
|---|---|---|
| `progress` | 0–1 \| null | fraction of route flown |
| `progress_basis` | `"fix"` \| `"clock"` | how `progress` was derived — **not for display** |
| `eta_utc` | ISO 8601 \| null | the single arrival estimate every surface renders |
| `eta_basis` | `"feed"` \| `"observed"` \| `"schedule"` | where `eta_utc` came from — **not for display** |
| `delay_min` | integer \| null | signed; negative is early |
| `delay_basis` | `"departure"` \| `"arrival"` \| null | which end `delay_min` refers to |

### The basis fields

`progress` is **always published** — the bar must never freeze. With a live fix it is the fix
projected onto the stored corridor (`"fix"`); without one it is elapsed time against block time
(`"clock"`). Both are legitimate answers to "roughly how far along is it", which is what a
progress bar claims.

`position`, by contrast, is published **only when a fix exists**. A bar saying *about halfway*
is supportable by a clock; a marker saying *the aircraft is at this point on the earth* is not.
Pretending otherwise is what drew FYC728 over Jordan while the real aircraft was 110 km east of
Damascus.

`eta_basis` distinguishes FR24's own estimate (`"feed"`), an arrival projected from observed
along-track rate (`"observed"`, once the anchor-plus-rate model exists), and the padded schedule
(`"schedule"`).

**The basis fields are for the map, not the user.** They let a surface decide how much to trust
a value — whether to snap the marker or ease toward it, how wide a confidence band to draw —
without ever surfacing the words "estimated" or "tracked", which are noise to a passenger. Same
principle as `position.source`.

`delay_basis` encodes the two-axis model: **on the ground, late is a state** (past the slot, not
yet departed); **airborne, late is a number** (revised arrival against schedule). FR24 conflates
these — it applies "Delayed" to aircraft flying perfectly normally — and we should not copy that.
Delay pairs with any phase: a flight can be `at_gate` and 40 minutes late, or `en_route` and 12
minutes early.

XH491 on 12 Aug is why both ends are needed: it departed 24 minutes late and arrived 7 seconds
early. A single status field has to pick one and misrepresent the other.

**`progress` is truth; interpolation is presentation.** The client should animate between
anchors so the marker does not jump each poll — but it must never derive the underlying fraction.
Every surface interpolating from the same anchor with the same rule stays coherent between polls
as well as at them.

---

## 4. Position

| field | type | notes |
|---|---|---|
| `position` | object \| null | `null` when no live fix |
| `position.lat` / `.lon` | number | |
| `position.altitude_ft` | integer | |
| `position.ground_speed_kts` | integer | |
| `position.track_deg` | integer | |
| `position.vertical_speed_fpm` | integer | |
| `position.on_ground` | boolean | |
| `position.fix_at` | ISO 8601 | measured 2–5 s old at collection |
| `position.source` | string | **not for display** — retained for guidance |

Altitude and speed are the natural detail line while airborne. `source` (`F-BDWY1`, `T-MLAT1`)
is deliberately not shown to users — it is noise to a passenger — but it is kept in the payload
because it tells the map how much to trust a fix.

Position exists for three jobs, none of which is decoration:

1. **Improve the state** — the three fine-grained phases above
2. **Make the map react to what the aircraft is doing** rather than to a clock
3. **Guide the flight when a stored path is carrying it** in the absence of live data

Our own receivers cannot see Syria at all — measured 11 Aug, nothing within 100 km of Damascus
below 1000 ft, the nearest low contacts being Beirut at 107 km. FR24's feed gave us 209 fixes
inside Syrian airspace on one arrival, including the roll-out on the ground.

---

## 5. Day bucketing and confidence

| field | type | notes |
|---|---|---|
| `dep_prev_day` | boolean | mirror of the existing `arr_next_day` |
| `dep_confirmed` | boolean | whether the departure time is settled |

**`dep_prev_day`** completes the two-board model. One flight row, two appearances: a flight
departing 22:00 and arriving 00:25 belongs on today's *departures* board as `22:00 → 00:25 +1`
and tomorrow's *arrivals* board as `22:00 -1 → 00:25`. The passenger looks at the first, the
family meeting them looks at the second. Affects 2.4% of flights.

Three rendering rules, each from a real case:

1. Compute the offset from the times **actually displayed** and recompute when they move. RB522
   was scheduled 21:00 → 00:00 (`+1`) and landed at 23:42, same day.
2. Treat a **negative** offset as bad source data and suppress the annotation rather than render
   it. FR24 served RB272 with an arrival 19 hours before its departure for an entire day.
3. Prefer showing the date over a bare `-1` on the arrivals view, since the offset is relative to
   the *board's* date — browsing the 10th's arrivals on the 12th makes `-1` mean the 9th.

**`dep_confirmed`** exists because departure times get revised and arrival times do not.
Measured over 17.5 hours: `real_dep` was corrected on **22 of 182 legs (12.1%)**, `real_arr` on
**0 of 163**. Of the 22 corrections, 20 began as a round minute and all 22 ended with precise
seconds — FYC727 was published as departing 14:47:00 while our own fixes had it stationary at
Damascus until 14:56:31, and was corrected to 14:57:48.

A round minute is not by itself proof of provisionality — 4 values stayed round for 36–50 hours
and were never corrected. So:

```
dep_confirmed = (seconds(real_dep) != 0) OR (position shows airborne)
```

Arrivals need no equivalent flag.

---

## 6. Delivery — decided 12 Aug

**Two endpoints, split by rate of change, not by subject.** The obvious split is "schedule vs
position" and it is wrong: if `phase` is derived from position but ships in the schedule
document, a client holds a phase from 60 seconds ago beside a position from 5 seconds ago — two
snapshots, and the disagreement we are trying to remove has been reinvented.

| document | carries | cadence |
|---|---|---|
| **schedule** | times, gates, terminals, aircraft, belt, `status`, `arr_next_day`, `dep_prev_day`, `dep_confirmed` | ~60 s |
| **live** | `position` **and everything derived from it** — `phase`, `progress`, `eta_utc`, `delay_min`, and their basis fields | ~30 s |

Source and derivation travel together, in one snapshot under one `as_of`. The card and the marker
read the same document, so they cannot disagree even in principle.

**One live document containing only what is live.** An arrived flight has no live state, so it
drops out on its own — it stays in the schedule document, which is where someone checking whether
a flight landed is looking anyway.

Measured 12 Aug: **87 flights across the day, 6.6 live on average, 15 at peak, 3 at the quietest
hour — 525 bytes for the 6 live at the time of measuring.** Under 2 KB even at peak. One cache
entry served to everyone, with nothing per-user about it, so the O(users) fan-out we removed
upstream does not reappear here. The cost this was guarding against is real in principle and
absent at Syrian traffic levels.

## 7. Open questions

- Whether the live document should be keyed by `iata_number` or `fr24_id`. The latter is what
  the position feed uses and needs no matching; the former is what every client already holds.

---

## 8. Rollout

Agreed sequence:

1. Extend `flight` and the API **additively** — the web receives the new fields immediately and
   ignores them harmlessly
2. Render in an **unpublished mobile build**, validate against real flights for a day
3. Port to web, together with the publisher/subscriber store the web currently lacks

Mobile first for a reason beyond caution: `board-store.ts` already implements one publisher and
many subscribers, built precisely because four independent clocks were disagreeing. The web has
no equivalent, and needs that pattern created before it can hold the coherence promise at all.

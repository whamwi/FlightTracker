"""
Recording where aircraft actually flew, and turning that into corridors.

68 of the 70 rows in `route_paths` have observed_count 0: they were hand-imported from a single
FR24 track each, by whoever happened to pick that flight. That is why DAM-JED matches Syrian Air
and is about 170 km wrong for flynas on every one of its thirteen flights a fortnight — nothing
has ever compared the stored path against what is being flown.

Two halves, both here:

  record()   every observed fix into flight_track_samples, with progress measured along the
             great circle so it owes nothing to a stored corridor that may itself be wrong
  learn()    per (dep, arr, operator), the per-bin median across flights -> route_paths_learned

Writes to its OWN tables. route_paths belongs to the website's map, and moving those corridors
would silently change what production draws.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx

from geo import gc_fraction, bins_for_route, consensus_path, haversine_km

SAMPLE_WINDOW_DAYS = 60          # rolling: airspace here changes politically, not seasonally
MIN_FLIGHTS = 2                  # below this there is no consensus, only an anecdote
OUTLIER_KM = 60                  # a flight this far from the consensus is a reroute, not noise
MIN_POINTS = 8                   # fewer fixes than this is a fragment, not a track

# Learning and promoting are deliberately different bars.
#
# MIN_FLIGHTS is what it takes to WRITE a corridor: cheap, reversible, and nothing downstream
# reads it. PROMOTE_MIN_FLIGHTS is what it takes to let one decide where the map draws an
# aircraft.
#
# FIVE, lowered from ten on 22 Aug. Ten was chosen when the alternative was two — "two flights
# agreeing is one anecdote confirming another" — and against that, ten was cautious in the right
# direction. What it was not weighed against is how wrong the ALTERNATIVE is: the stored paths
# these replace sit 80 to 224 km from where aircraft actually fly, because they were imported
# from single tracks back when Iraqi overflight was normal and the Gulf routes now go around it.
# Waiting for a tenth flight to replace a corridor that puts an aeroplane in the wrong country is
# the wrong trade. Measured: at ten, 14 pairs carrying 38% of legs; at five, the 34-pair block
# sitting at 4-6 promotes too, taking it past 70%.
PROMOTE_MIN_FLIGHTS = 5

# The thin-route floor, and how a route is known to be thin.
#
# Once-weekly services cannot reach five in any useful time — Deir ez-Zor is filed {sat,wed}, so
# five tracks is over a month. Two is the least that can be a consensus at all (MIN_FLIGHTS), and
# for a route that will never do better it beats a great circle drawn through whatever terrain
# happens to lie between the airports.
#
# THINNESS IS READ FROM THE SCHEDULE, NOT INFERRED FROM TIME. The first version of this waited
# seven days and then decided a route was thin because it still had not reached five. That works,
# but it spends a week rediscovering something route_master has always known: how many days a week
# the service operates. A route filed on two days or fewer is thin on its first flight.
#
# The distinction the age test was protecting still matters — a DAILY route with two tracks is a
# route observed since yesterday, and promoting it is the anecdote problem this bar exists to
# prevent. The schedule separates them outright instead of waiting: two filed days means thin,
# seven means new.
#
# Where no schedule is filed, no floor applies. An unknown route waits for the ordinary bar, which
# is the safe direction.
PROMOTE_MIN_THIN = 2
THIN_MAX_DAYS_PER_WEEK = 2

# A corridor that rejected this share of its own flights is CONTESTED, and must not be drawn.
#
# The outlier filter exists to throw out the occasional reroute. When it throws out a third of
# the route instead, it is not filtering noise — it is choosing between two standing routings and
# calling the losers outliers. IST-DAM THY measured 12 kept against 7 rejected on 26 Aug: two
# corridors 200 km apart, one via Antalya and one via Ankara, and Turkish picks one per day.
#
# The stored corridor is then whichever cluster happened to be larger, so drawing with it is
# wrong by 200 km for a substantial minority of flights — worse than the great circle, which at
# least sits between them.
#
# A RATE, not a list. Naming IST-DAM THY would fix today's case and leave the next one to be
# found by somebody looking at a screen. Measured across every corridor on the same day, the
# separation is clean: the contested pair rejects 37%, and every other rejects 11% or less.
CONTESTED_OUTLIER_RATIO = 0.25


def is_contested(observed_count: int | None, outliers_excluded: int | None) -> bool:
    """
    Whether a corridor is really two, and so cannot be drawn as one.

    Judged on the share rejected rather than the count: one reroute out of twenty-seven is a
    reroute, seven out of nineteen is a second route.
    """
    kept = observed_count or 0
    out = outliers_excluded or 0
    total = kept + out
    return total > 0 and (out / total) >= CONTESTED_OUTLIER_RATIO


def is_promotable(observed_count: int | None, days_per_week: int | None = None) -> bool:
    """
    Whether a learned corridor has earned the right to be drawn.

    Two ways to qualify: the ordinary bar, or the thin-route floor when the filed schedule says
    the service runs on two days a week or fewer and so will never reach the ordinary one.

    `days_per_week` is omitted where the schedule is not to hand — the learner's own response
    reports the strict bar, and /v2/route-readiness, which has route_master beside it, applies
    the floor.
    """
    n = observed_count or 0
    if n >= PROMOTE_MIN_FLIGHTS:
        return True
    if n < PROMOTE_MIN_THIN or not days_per_week:
        return False
    return days_per_week <= THIN_MAX_DAYS_PER_WEEK


async def record(client, sb, sb_headers: dict, flights: list[dict], aps: dict) -> int:
    """
    One row per airborne observed fix. Cheap, append-only, and unconditional — a route with no
    corridor is exactly the one we most need samples for, and `route_path_samples` cannot hold
    those at all because its s and off_path_km are NOT NULL.
    """
    rows = []
    for f in flights:
        p = f.get("position") or {}
        if p.get("pos_source") != "observed" or p.get("lat") is None:
            continue
        if p.get("on_ground") is True:
            continue                       # taxi tracks are not a route
        dep, arr = f.get("dep_iata"), f.get("arr_iata")
        dc, ac = aps.get(dep or ""), aps.get(arr or "")
        cs = (f.get("callsign") or "").strip().upper()
        if not (dep and arr and dc and ac and cs and p.get("fix_at")):
            continue
        rows.append({
            "callsign": cs,
            # Both identifiers. Every flight here has two — THY846 broadcasts, TK846 is on the
            # ticket — and assuming one has broken things silently before. Storing the pair also
            # means per-flight-number analysis needs no callsign parsing.
            "iata_number": f.get("iata_number"),
            "dep_iata": dep,
            "arr_iata": arr,
            "flight_date": f.get("flight_date"),
            "seen_at": p["fix_at"],
            "lat": p["lat"], "lon": p["lon"],
            "gc_fraction": gc_fraction(dc, ac, p["lat"], p["lon"]),
            "alt_ft": p.get("altitude_ft"),
            "gs_kts": p.get("ground_speed_kts"),
            "track_deg": p.get("track_deg"),
            "source": p.get("source"),
        })
    if not rows:
        return 0

    # One aircraft, one position, one instant.
    #
    # Two board rows for the same aeroplane are handed the SAME fix, because position is looked
    # up by callsign, and each would write it under its own flight_date. RJA437 did exactly that
    # on 17 Aug while its identity flipped from the 16th to the 17th mid-flight — both rows in a
    # single batch, same created_at — and 12 callsigns were carrying two open rows at the time,
    # so the pairing is ordinary rather than exotic.
    #
    # The unique key is now (callsign, seen_at) and would catch this on its own; it used to be
    # (callsign, flight_date, seen_at), which put OUR attribution in the key and so defended
    # nothing. This stays as the in-batch statement of the same rule: one aeroplane cannot be in
    # two places at one instant, so it contributes one sample, and the intent is visible here
    # rather than only in the schema. A duplicate is not merely untidy — these rows are the
    # corridor-learning input, and a doubled sample silently double-weights one flight in a
    # per-bin median.
    seen_fix: set[tuple] = set()
    unique = []
    for r in rows:
        k = (r["callsign"], r["seen_at"])
        if k in seen_fix:
            continue
        seen_fix.add(k)
        unique.append(r)
    rows = unique
    # Duplicates ignored rather than raised: the document is cached, so consecutive builds offer
    # the same fix again, and the unique index is what makes that harmless.
    r = await client.post(
        f"{sb}/rest/v1/flight_track_samples",
        headers={**sb_headers, "Content-Type": "application/json",
                 "Prefer": "resolution=ignore-duplicates,return=minimal"},
        json=rows, timeout=30,
    )
    return len(rows) if r.status_code < 300 else 0


async def learn(client, sb, sb_headers: dict, aps: dict) -> tuple[list[dict], list[dict]]:
    """
    Turn the samples into corridors. Intended for a scheduled call, not a request.

    Grouped by (dep, arr, operator) because that is where the variance lives: the same airline's
    flight numbers agree within about 5 km on thirteen of fourteen routes measured, while two
    airlines on one city pair differ by 170.

    Returns (written, skipped). The second half is the point: a pair that produced no corridor
    used to just `continue`, so "we have never seen this route" and "we have seen it and its
    flights contradict each other" were the same silence. The second is a finding — DAM-RUH is
    two routings, not one noisy one — and it was invisible in route_paths_learned precisely
    BECAUSE it was interesting enough to be dropped.
    """
    since = quote((datetime.now(timezone.utc) - timedelta(days=SAMPLE_WINDOW_DAYS)).isoformat(),
                  safe="")
    rows = await _get(client, sb, sb_headers,
                      "flight_track_samples?select=callsign,operator,dep_iata,arr_iata,"
                      f"flight_date,lat,lon,gc_fraction&seen_at=gte.{since}&order=id")

    # (dep, arr, operator) -> flight key -> points
    grouped: dict[tuple, dict[tuple, list[dict]]] = {}
    for r in rows:
        key = (r["dep_iata"], r["arr_iata"], r["operator"])
        flight = (r["callsign"], r["flight_date"])
        grouped.setdefault(key, {}).setdefault(flight, []).append(r)

    written, skipped = [], []

    def skip(dep, arr, op, reason, **extra):
        skipped.append({"dep_iata": dep, "arr_iata": arr, "operator": op,
                        "reason": reason, **extra})

    for (dep, arr, op), flights in grouped.items():
        tracks = [pts for pts in flights.values() if len(pts) >= MIN_POINTS]
        if len(tracks) < MIN_FLIGHTS:
            skip(dep, arr, op, "too_few_flights",
                 usable_tracks=len(tracks), legs_seen=len(flights))
            continue

        # Sliced to the length of the route, not to a constant.
        #
        # A bin narrower than the ground covered between two samples is a bin two flights will
        # never share, and a waypoint needs two flights to agree. At a flat 40, Amman-Damascus
        # produced ZERO shared bins across two legs — 4.5 km a bin against a 14 km sampling
        # stride — so the shortest routes, which are exactly the ones ADS-B sees best, could
        # never learn a corridor at all. See bins_for_route.
        dc, ac = aps.get(dep or ""), aps.get(arr or "")
        route_km = haversine_km(dc, ac) if dc and ac else None
        nbins = bins_for_route(route_km)

        path = consensus_path(tracks, bins=nbins)
        if not path:
            # No bin that two flights both crossed. Sampling too sparse for the route's length.
            skip(dep, arr, op, "no_shared_bins", usable_tracks=len(tracks), bins=nbins)
            continue

        kept, outliers = partition_by_agreement(path, flights)

        if outliers:
            if len(kept) < MIN_FLIGHTS:
                # Nothing agrees with anything. Two flights 417 km apart — KNE388 and KNE378 into
                # Riyadh on 17 Aug — are two different routings with one example each, not a
                # corridor and its outlier.
                #
                # This used to say the median of two is "a line down the middle that neither
                # flew". It is not: consensus_path takes lats[len // 2], so with exactly two
                # tracks the corridor IS the upper one, and the other becomes the lone outlier.
                # The rule is right for a different reason — one surviving flight is an anecdote,
                # and storing it would draw every DAM-RUH flight along whichever of the two
                # routings happened to sort higher. Half the time that is the wrong one, and
                # nothing downstream would say so.
                #
                # Discovered only once variable binning let this route past the resolution gate,
                # which had been hiding it. The old code wrote the contaminated path anyway and
                # labelled it observed_count 1.
                skip(dep, arr, op, "no_agreement",
                     usable_tracks=len(tracks), outliers=outliers, agreed=len(kept))
                continue
            # Recompute without them, so one bad day cannot even half-shift the median.
            path = consensus_path([flights[k] for k in kept], bins=nbins) or path

        written.append({
            "dep_iata": dep, "arr_iata": arr, "operator": op,
            "waypoints": path,
            "observed_count": len(kept) or len(tracks),
            "sample_count": sum(len(p) for p in flights.values()),
            "source_flights": [f"{c}/{d}" for c, d in kept][:50],
            "outliers_excluded": outliers,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })

    for i in range(0, len(written), 50):
        await client.post(
            f"{sb}/rest/v1/route_paths_learned",
            headers={**sb_headers, "Content-Type": "application/json",
                     "Prefer": "resolution=merge-duplicates,return=minimal"},
            json=written[i:i + 50], timeout=60,
        )
    return written, skipped


# ── #44: some pairs fly TWO corridors, and the median picks one and calls the rest outliers ──
#
# Measured 24 Aug on IST->DAM THY, 15 legs:
#
#   cluster A  mid ~37.0N 32.2E   6 legs   (near the great circle, via Antalya)
#   cluster B  mid ~38.2N 34.2E   9 legs   (the dogleg, via Ankara)
#                                 ~200 km apart at mid-route
#
# Nine won the median and six were rejected — the 9/6 in that run's outlier count. Every other
# pair rejects zero or one, so a 40% rejection rate is the signature of this, not of noise.
#
# THREE THINGS THAT ARE NOT THE ANSWER, each checked rather than assumed:
#
#   Finer grouping. Splitting by flight number explains 22% of the spread on this pair and 0-30%
#   across every pair with more than one number — negative on three. THY846 and THY848 each
#   appear in BOTH clusters. Below operator there is nothing left to explain, which is the same
#   conclusion the grouping comment above reaches from the other direction.
#
#   Averaging them. The median of both sits ~100 km from each, worse than picking either.
#
#   A stored default. The airline varies it day to day, so whichever is stored is wrong ~40% of
#   the time by 200 km.
#
# WHAT DOES WORK: pick the corridor from the flight's OWN fixes. The two routings separate fast —
# 52 km at ten minutes from the first fix, 110 at fifteen, 176 at twenty, peaking near 260 over
# central Anatolia before converging toward Damascus. So one fix a quarter of an hour in decides
# it for the remaining hour and three quarters, and that is exactly where coverage is good, since
# Istanbul sits inside the 41.0/29.0 circle.
#
# So the shape is: keep BOTH clusters for a pair that has them, and choose per flight by
# proximity to what has actually been observed. A flight seen nowhere at all stays ambiguous, and
# for that one the great circle is the honest answer rather than a coin flip between two.
#
# Until this exists, IST->DAM THY should not be trusted for projection even though it counts as
# promotable: its stored corridor is the dogleg, so the six direct legs would be drawn 200 km off.


def partition_by_agreement(path: list[dict], flights: dict) -> tuple[list, int]:
    """
    Which flights actually agree with the consensus, and how many did not.

    A reroute is real and belongs in the samples, but not in the consensus — SYR342 flew KWI-DAM
    7 km from the others one day and 231 km another. Judged on the MEDIAN offset rather than the
    worst one, so a flight that merely dog-legs around weather for ten minutes still counts as
    agreeing.

    Extracted so that the test and the caller run the same code. It used to live inline in learn(),
    which meant the test that proves outliers are rejected was a re-implementation of the rule
    rather than an exercise of it — the arrangement in which a filter can quietly stop working
    while its test goes on passing.
    """
    kept, outliers = [], 0
    for key, pts in flights.items():
        if len(pts) < MIN_POINTS:
            continue
        offs = sorted(_off_path_km(path, p) for p in pts)
        if offs and offs[len(offs) // 2] > OUTLIER_KM:
            outliers += 1
        else:
            kept.append(key)
    return kept, outliers


def _off_path_km(path: list[dict], point: dict) -> float:
    """Nearest waypoint distance. Coarse on purpose — this only has to sort reroutes from noise."""
    return min(haversine_km((w["lat"], w["lon"]), (point["lat"], point["lon"])) for w in path)


PAGE = 1000          # PostgREST's server-side ceiling, whatever the query string asks for


async def _get(client, sb, sb_headers, q: str) -> list[dict]:
    """
    Every row, in pages.

    PostgREST caps a response at 1,000 rows and ignores a larger `limit` in the query string —
    silently, with a 200. The first version of this asked for 200,000, got 1,000, and produced
    zero corridors from 2,837 samples because almost every route came back with one usable track
    instead of two. A truncation that looks like a successful answer is worse than an error.

    Paged by Range rather than offset: PostgREST answers it natively and reports the total in
    Content-Range, so a short page is a real end rather than a guess.
    """
    # An unordered paged read is a silent data loss, so it is refused rather than allowed.
    #
    # Range paging over a result with no ORDER BY is undefined: Postgres may return rows in any
    # order per page, so page 2 can repeat page 1 and skip rows entirely — and the failure grows
    # with the table, which is the worst shape for it. /v2/route-readiness shipped without one and
    # reported 295 tracks against a true 488, hiding half the corridors that had qualified.
    #
    # Raised, not silently appended: the caller must choose a key that is stable for its query.
    if "order=" not in q:
        raise ValueError(f"_get requires an explicit order= for stable paging: {q[:80]}")

    out: list[dict] = []
    start = 0
    while True:
        r = await client.get(
            f"{sb}/rest/v1/{q}",
            headers={**sb_headers, "Range-Unit": "items", "Range": f"{start}-{start + PAGE - 1}"},
            timeout=120,
        )
        r.raise_for_status()
        page = r.json()
        out.extend(page)
        if len(page) < PAGE:
            return out
        start += PAGE

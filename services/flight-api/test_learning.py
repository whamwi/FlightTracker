"""
Learning a corridor from what was actually flown.

Run:  python3 services/flight-api/test_learning.py

Both functions are pure. No network, no database, no clock.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from geo import (MAX_BINS, MIN_BINS, SEAM_BLEND_F, bins_for_route, covered_span,
                 gc_fraction, consensus_path, great_circle_path, haversine_km,
                 interpolate_path, position_on_route)

DAM = (33.411, 36.514)
JED = (21.680, 39.157)
KWI = (29.227, 47.969)


# ── Progress along the great circle ───────────────────────────────────────────

def test_the_ends_are_zero_and_one():
    assert gc_fraction(DAM, JED, *DAM) == 0.0
    assert abs(gc_fraction(DAM, JED, *JED) - 1.0) < 1e-9


def test_the_midpoint_is_half_way():
    mid = ((DAM[0] + JED[0]) / 2, (DAM[1] + JED[1]) / 2)
    assert abs(gc_fraction(DAM, JED, *mid) - 0.5) < 0.01


def test_being_far_off_to_the_side_barely_moves_the_progress():
    """
    The property `s` does not have. flynas flies DAM-JED about 170 km from the stored corridor;
    if lateral distance pushed the fraction around, its samples would land in the wrong bins and
    the learned path would be a smear.
    """
    mid = ((DAM[0] + JED[0]) / 2, (DAM[1] + JED[1]) / 2)
    on_track = gc_fraction(DAM, JED, *mid)
    off_track = gc_fraction(DAM, JED, mid[0], mid[1] + 2.0)      # ~200 km to the side
    assert abs(off_track - on_track) < 0.05, f"{on_track:.3f} vs {off_track:.3f}"


def test_it_clamps_rather_than_going_negative():
    # Still on the ground behind the origin, or past the destination on a go-around.
    assert gc_fraction(DAM, JED, 35.0, 35.0) == 0.0
    assert gc_fraction(DAM, JED, 18.0, 40.0) == 1.0


def test_a_zero_length_route_does_not_divide_by_zero():
    assert gc_fraction(DAM, DAM, *DAM) == 0.0


# ── The consensus ─────────────────────────────────────────────────────────────

def straight_track(offset_lon=0.0, n=40):
    """A flight along DAM->KWI, displaced sideways by a constant."""
    return [{"gc_fraction": i / (n - 1),
             "lat": DAM[0] + (KWI[0] - DAM[0]) * i / (n - 1),
             "lon": DAM[1] + (KWI[1] - DAM[1]) * i / (n - 1) + offset_lon}
            for i in range(n)]


def test_one_flight_is_not_a_consensus():
    assert consensus_path([straight_track()]) is None


def test_two_agreeing_flights_produce_the_path_they_flew():
    path = consensus_path([straight_track(), straight_track()])
    assert path is not None and len(path) >= 10
    assert path[0]["f"] < path[-1]["f"], "ordered by progress"
    # The middle of the learned path sits on the line they flew.
    mid = path[len(path) // 2]
    assert abs(mid["lat"] - (DAM[0] + KWI[0]) / 2) < 1.0


def test_one_wild_reroute_cannot_move_the_corridor():
    """
    SYR342 flew KWI-DAM at 7 km from the others one day and 231 km another. A mean would drag
    the corridor sideways for good; the median must not notice.
    """
    normal = [straight_track(0.0) for _ in range(9)]
    rogue = straight_track(3.0)                                   # ~300 km off
    clean = consensus_path(normal)
    with_rogue = consensus_path(normal + [rogue])
    mid_clean = clean[len(clean) // 2]
    mid_rogue = with_rogue[len(with_rogue) // 2]
    moved = haversine_km((mid_clean["lat"], mid_clean["lon"]),
                         (mid_rogue["lat"], mid_rogue["lon"]))
    assert moved < 5, f"the corridor moved {moved:.1f} km"


def test_a_flight_with_more_fixes_does_not_outvote_one_with_fewer():
    """
    One point per bin per flight, so a flight sampled every two seconds carries the same weight
    as one sampled every minute. Without it a dense track wins by volume rather than by being
    where more aeroplanes were.

    Both sets are sampled densely enough to reach every bin — otherwise this measures bin
    coverage rather than voting weight, which is what it did on the first attempt.
    """
    dense = [straight_track(0.0, n=300) for _ in range(2)]
    sparse = [straight_track(2.0, n=60) for _ in range(3)]
    path = consensus_path(dense + sparse)
    mid = path[len(path) // 2]
    # Three flights beat two regardless of how many fixes each carried.
    assert mid["lon"] > (DAM[1] + KWI[1]) / 2 + 1.0, "the dense pair outvoted the sparse trio"


def test_a_fragment_is_refused():
    # Two flights that were only ever seen near the start describe a departure, not a route.
    stub = [{"gc_fraction": 0.01 * i, "lat": DAM[0], "lon": DAM[1]} for i in range(3)]
    assert consensus_path([stub, stub]) is None


def test_gaps_are_left_for_the_interpolator_rather_than_invented():
    # No coverage in the middle: those bins are absent, not filled with a guess.
    def split(off=0.0):
        return [p for p in straight_track(off) if p["gc_fraction"] < 0.3 or p["gc_fraction"] > 0.7]
    path = consensus_path([split(), split()])
    assert path is not None
    assert not any(0.35 < p["f"] < 0.65 for p in path), "a gap is not a waypoint"


# ── Slicing a route to its length ─────────────────────────────────────────────

def test_a_short_hop_is_not_sliced_more_finely_than_we_sample_it():
    """
    Amman-Damascus is about 180 km. At a flat 40 bins that is 4.5 km a bin, roughly 19 seconds at
    cruise, against a sampling stride nearer 14 km — so a flight lands a point every third bin and
    two flights almost never share one. Measured 17 Aug: RJA437's two legs shared ZERO bins of 40,
    and the route could not learn a corridor at all.
    """
    assert bins_for_route(180) <= 10


def test_a_long_route_keeps_the_resolution_it_already_had():
    # DAM-SHJ is about 2,000 km and shared 41 bins of 40 under the old constant. Nothing to fix.
    assert bins_for_route(2000) == MAX_BINS


def test_the_slice_is_never_finer_than_the_sampling_stride():
    # 25 km a bin, against roughly 14 km between samples at 450 kt on a 60-second cadence.
    for km in (120, 300, 700, 1300, 2500):
        assert km / bins_for_route(km) >= 14.0, km


def test_a_very_short_route_still_gets_enough_bins_to_be_a_shape():
    # Below the floor a corridor stops describing anything. Four waypoints is a line, not a route.
    assert bins_for_route(30) == MIN_BINS
    assert bins_for_route(1) == MIN_BINS


def test_an_unknown_length_falls_back_to_the_old_constant():
    # A missing airport should not silently coarsen every corridor to the floor.
    assert bins_for_route(None) == MAX_BINS
    assert bins_for_route(0) == MAX_BINS


def test_two_sparse_legs_of_a_short_route_now_reach_consensus():
    """
    The end-to-end point. Two legs down one short corridor, sampled coarsely and at different
    moments, so they interleave rather than coincide — which is exactly what defeated the flat
    binning.
    """
    dep, arr = (31.72, 35.99), (33.41, 36.52)          # AMM -> DAM
    km = haversine_km(dep, arr)

    def leg(offset):
        pts = []
        for i in range(10):
            f = min(1.0, offset + i * 0.1)
            pts.append({"gc_fraction": f,
                        "lat": dep[0] + (arr[0] - dep[0]) * f,
                        "lon": dep[1] + (arr[1] - dep[1]) * f})
        return pts

    tracks = [leg(0.00), leg(0.04)]                    # interleaved, never the same fraction
    assert consensus_path(tracks, bins=40) is None, "the old behaviour, reproduced"
    path = consensus_path(tracks, bins=bins_for_route(km))
    assert path, "sliced to the route, the same two legs agree"
    assert len(path) >= 4


def test_a_route_with_no_agreement_at_all_stores_nothing():
    """
    Two flights 417 km apart — KNE388 and KNE378 into Riyadh on 17 Aug — are two different
    routings with one example each, not a corridor and its outlier. The median of them is a line
    down the middle that neither flew, and drawing every DAM-RUH flight there would be worse than
    drawing none.

    This is asserted through learn()'s rule rather than consensus_path, which will happily
    average anything it is given: the judgement belongs to the caller that knows what an outlier
    is.

    It calls partition_by_agreement — the function learn() itself calls. It used to re-implement
    that loop here, which meant the test could keep passing while the real filter was broken or
    bypassed. A test that reproduces the logic it is checking proves only that the logic can be
    written twice.
    """
    from learn import MIN_FLIGHTS, partition_by_agreement

    # Same endpoints, wildly different middles.
    a = straight_between(33.41, 36.52, 24.96, 46.70)
    b = [dict(p, lat=p["lat"] + 3.5) for p in a]          # a few hundred km north
    path = consensus_path([a, b], bins=40)
    assert path, "a median exists, which is exactly the danger"

    kept, outliers = partition_by_agreement(path, {("KNE388", "d"): a, ("KNE378", "d"): b})

    # ONE outlier, not two, and the reason matters more than the count.
    #
    # consensus_path takes lats[len // 2], which for two flights is the upper one rather than the
    # mean — so with exactly two tracks the corridor IS one of them, exactly. That flight then
    # sits 0 km from the consensus and only its opposite is rejected.
    #
    # The outcome is still right, and for a better reason than the one originally written down
    # here: the pair is dropped because one surviving flight is below MIN_FLIGHTS, not because
    # the median was a line down the middle nobody flew. At two flights it never is.
    assert outliers == 1, f"the median is one of the two, so only its opposite is off: {outliers}"
    assert len(kept) < MIN_FLIGHTS, "one flight left is an anecdote, not a corridor"


def straight_between(lat0, lon0, lat1, lon1, n=12):
    return [{"gc_fraction": i / (n - 1),
             "lat": lat0 + (lat1 - lat0) * i / (n - 1),
             "lon": lon0 + (lon1 - lon0) * i / (n - 1)} for i in range(n)]


def test_the_outlier_is_dropped_and_the_agreeing_flights_are_kept():
    """
    The other half of the same rule, which nothing covered: when MOST flights agree, the filter
    must keep them and reject only the reroute. `test_a_route_with_no_agreement` proves it can
    reject everything, which a filter that rejects unconditionally would also pass.
    """
    from learn import partition_by_agreement

    base = straight_between(33.41, 36.52, 24.96, 46.70)
    flights = {(f"KNE{i}", "d"): [dict(p) for p in base] for i in range(4)}
    flights[("KNE999", "d")] = [dict(p, lat=p["lat"] + 3.5) for p in base]   # the reroute

    path = consensus_path(list(flights.values())[:4], bins=40)
    kept, outliers = partition_by_agreement(path, flights)

    assert outliers == 1, f"only the reroute should be rejected, got {outliers}"
    assert len(kept) == 4
    assert ("KNE999", "d") not in kept


def test_a_fragment_is_not_counted_as_a_flight_that_agrees():
    """A track too short to judge must not quietly become a vote. MIN_POINTS, not len() > 0."""
    from learn import partition_by_agreement, MIN_POINTS

    base = straight_between(33.41, 36.52, 24.96, 46.70)
    path = consensus_path([base, [dict(p) for p in base]], bins=40)
    kept, outliers = partition_by_agreement(path, {("SHORT", "d"): base[:MIN_POINTS - 1]})
    assert kept == [] and outliers == 0, "a fragment is neither agreement nor disagreement"


def test_learning_and_promoting_are_different_bars():
    """
    Two flights are enough to WRITE a corridor and must never be enough to DRAW one. The whole
    point of the second constant is that it is strictly higher than the first.
    """
    from learn import MIN_FLIGHTS, PROMOTE_MIN_FLIGHTS, is_promotable

    assert PROMOTE_MIN_FLIGHTS > MIN_FLIGHTS
    assert not is_promotable(MIN_FLIGHTS)
    assert not is_promotable(PROMOTE_MIN_FLIGHTS - 1)
    assert is_promotable(PROMOTE_MIN_FLIGHTS)
    assert not is_promotable(None), "a corridor with no count is not promotable"
    assert not is_promotable(0)


# ── Using a corridor that does not cover the whole route ──────────────────────

GC = great_circle_path(DAM, KWI)


def half_corridor(offset_lon=1.0):
    """A corridor over the first 60% of DAM->KWI, displaced sideways so it is distinguishable."""
    return [w for w in
            [{"f": i / 39, "lat": DAM[0] + (KWI[0] - DAM[0]) * i / 39,
              "lon": DAM[1] + (KWI[1] - DAM[1]) * i / 39 + offset_lon} for i in range(40)]
            if w["f"] <= 0.6]


def test_the_corridor_is_used_where_it_covers_the_route():
    pos = position_on_route(half_corridor(), GC, 0.3)
    gc = interpolate_path(GC, 0.3)
    assert haversine_km(pos, gc) > 50, "displaced from the great circle, i.e. the corridor won"


def test_the_great_circle_is_used_well_past_the_corridors_end():
    """
    interpolate_path CLAMPS: past the last waypoint it returns that waypoint, so an aircraft two
    thirds of the way to Kuwait would be drawn pinned where our samples ran out. Measured on
    FDB1848: 156.8 km median that way, against 59 km for the plain great circle.
    """
    pos = position_on_route(half_corridor(), GC, 0.95)
    gc = interpolate_path(GC, 0.95)
    assert haversine_km(pos, gc) < 1.0, "beyond the blend it is the great circle"

    # The old behaviour, for contrast: on this 1,183 km route the clamp lands 345 km away.
    clamped = interpolate_path(half_corridor(), 0.95)
    assert haversine_km(clamped, gc) > 100 * haversine_km(pos, gc) + 100


def test_the_marker_does_not_jump_where_the_corridor_ends():
    # The corridor and the great circle are up to OUTLIER_KM apart at the seam. A hard switch
    # would teleport the marker sideways by that much in one poll.
    corr = half_corridor()
    hi = covered_span(corr)[1]
    step = 0.002
    a = position_on_route(corr, GC, hi - step)
    b = position_on_route(corr, GC, hi + step)
    assert haversine_km(a, b) < 15, f"jumped {haversine_km(a, b):.1f} km at the seam"


def test_the_blend_finishes_where_the_great_circle_is():
    corr = half_corridor()
    hi = covered_span(corr)[1]
    at_end = position_on_route(corr, GC, hi + SEAM_BLEND_F)
    assert haversine_km(at_end, interpolate_path(GC, hi + SEAM_BLEND_F)) < 1.0


def test_no_corridor_at_all_is_simply_the_great_circle():
    for empty in (None, [], [{"f": 0.5, "lat": 33.0, "lon": 37.0}]):
        pos = position_on_route(empty, GC, 0.4)
        assert haversine_km(pos, interpolate_path(GC, 0.4)) < 1.0


def test_a_corridor_that_starts_late_is_not_used_before_it_starts():
    # Coverage grows from the middle outwards as often as from the start.
    late = [w for w in half_corridor(offset_lon=1.0) if w["f"] >= 0.3]
    pos = position_on_route(late, GC, 0.05)
    assert haversine_km(pos, interpolate_path(GC, 0.05)) < 1.0


def test_the_covered_span_is_what_the_waypoints_actually_describe():
    assert covered_span(half_corridor())[0] == 0.0
    assert 0.55 <= covered_span(half_corridor())[1] <= 0.6
    assert covered_span([]) is None
    assert covered_span(None) is None


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as e:
                fails += 1
                print(f"FAIL {name}: {e}")
    print(f"\n{fails} failed")
    sys.exit(1 if fails else 0)

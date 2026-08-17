"""
Learning a corridor from what was actually flown.

Run:  python3 services/flight-api/test_learning.py

Both functions are pure. No network, no database, no clock.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from geo import (MAX_BINS, MIN_BINS, bins_for_route, gc_fraction, consensus_path,
                 haversine_km)

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
    """
    from learn import MIN_FLIGHTS, OUTLIER_KM, _off_path_km

    def straight(lat0, lon0, lat1, lon1, n=12):
        return [{"gc_fraction": i / (n - 1),
                 "lat": lat0 + (lat1 - lat0) * i / (n - 1),
                 "lon": lon0 + (lon1 - lon0) * i / (n - 1)} for i in range(n)]

    # Same endpoints, wildly different middles.
    a = straight(33.41, 36.52, 24.96, 46.70)
    b = [dict(p, lat=p["lat"] + 3.5) for p in a]          # a few hundred km north
    path = consensus_path([a, b], bins=40)
    assert path, "a median exists, which is exactly the danger"

    kept = []
    for track in (a, b):
        offs = sorted(_off_path_km(path, p) for p in track)
        if offs[len(offs) // 2] <= OUTLIER_KM:
            kept.append(track)
    assert len(kept) < MIN_FLIGHTS, "neither flight agrees with the average of the two"


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

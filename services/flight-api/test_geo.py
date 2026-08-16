"""
Tests for the one place that decides where an aeroplane is.

Run:  python3 services/flight-api/test_geo.py
  or: python3 -m pytest services/flight-api/test_geo.py -q

geo.py is pure — no database, no network, no app, and `now` is always a parameter — so this
runs anywhere. It imports geo directly rather than main, so it needs no configuration either.
"""

import math
import sys

from geo import (
    is_plausible_fix,
    within_projection_window,
    drop_sentinel_fixes,
    interpolate_path,
    bearing_from_path,
    great_circle_path,
    project_position,
)

# ── The corrupt sweep of 16 Aug, verbatim from aircraft_last_seen ─────────────
# Real rows rather than invented ones: the guard has to survive the shape the aggregator
# actually produced, including the genuine altitudes and the one row whose speed looked fine.

AMMAN = {"lat": 31.71711, "lon": 35.999341}
CORRUPT_SWEEP = [
    {"hex": "424c00", **AMMAN, "alt_baro": 32000, "gs": 0.7, "track": 0},      # M-SSML
    {"hex": "710db9", **AMMAN, "alt_baro": 31000, "gs": 0.7, "track": 0},      # KNE252
    {"hex": "71145e", **AMMAN, "alt_baro": 17850, "gs": 0.7, "track": 0},      # FAD562
    {"hex": "706132", **AMMAN, "alt_baro": 37025, "gs": 0.7, "track": 0},      # JZR174
    {"hex": "010169", **AMMAN, "alt_baro": 35000, "gs": 456, "track": 154.16},  # PER002
]

REAL = {"hex": "4bb290", "lat": 34.9912, "lon": 37.8703,
        "alt_baro": 33000, "gs": 448, "track": 335}

DAM = (33.411, 36.514)
KWI = (29.227, 47.969)
DXB = (25.253, 55.365)

HOUR = 3_600_000
T0 = 1_755_340_800_000        # a fixed instant; nothing here reads a clock


# ── Plausibility ──────────────────────────────────────────────────────────────

def test_rejects_cruise_altitude_at_walking_pace():
    for fix in (f for f in CORRUPT_SWEEP if f["gs"] < 50):
        assert not is_plausible_fix(fix), f"{fix['hex']} at {fix['gs']} kt / {fix['alt_baro']} ft"


def test_accepts_a_genuine_fix():
    assert is_plausible_fix(REAL)


def test_does_not_reject_a_slow_aircraft_near_the_ground():
    # Taxiing and rollout are exactly what a naive speed floor would break, and the map is
    # meant to show an aircraft on the runway at Damascus.
    assert is_plausible_fix({"hex": "a", "lat": 33.41, "lon": 36.51, "alt_baro": 2000, "gs": 12})
    assert is_plausible_fix({"hex": "a", "lat": 33.41, "lon": 36.51, "alt_baro": 0, "gs": 0})


def test_reads_the_v2_field_names_too():
    # /v2/live names these altitude_ft and ground_speed_kts; the aggregator names them
    # alt_baro and gs. One guard, both shapes, so neither path can be left unguarded.
    assert not is_plausible_fix(
        {"hex": "a", "lat": 31.7, "lon": 36.0, "altitude_ft": 35000, "ground_speed_kts": 0.7})


def test_rejects_missing_out_of_range_and_null_island():
    assert not is_plausible_fix({"lat": None, "lon": 36})
    assert not is_plausible_fix({"lat": "x", "lon": 36})
    assert not is_plausible_fix({"lat": 91, "lon": 36})
    assert not is_plausible_fix({"lat": 0, "lon": 0})
    assert not is_plausible_fix({"lat": True, "lon": 36})     # bool is not a coordinate


def test_a_fix_with_no_altitude_or_speed_is_judged_on_position_alone():
    # FR24 rows carry neither. Refusing them would empty the map to spite the aggregator.
    assert is_plausible_fix({"hex": "b", "lat": 33.4, "lon": 36.5})


# ── Sentinels ─────────────────────────────────────────────────────────────────

def test_discards_every_aircraft_sharing_one_coordinate():
    kept = drop_sentinel_fixes(CORRUPT_SWEEP)
    assert kept == [], "PER002 looked fine on its own and was still a placeholder"


def test_leaves_a_healthy_sweep_untouched():
    sweep = [REAL,
             {"hex": "06a0ac", "lat": 33.6923, "lon": 38.0303, "alt_baro": 38975, "gs": 470},
             {"hex": "3c7984", "lat": 34.3721, "lon": 37.4769, "alt_baro": 33375, "gs": 455}]
    assert drop_sentinel_fixes(sweep) == sweep


def test_one_aircraft_alone_at_a_coordinate_survives():
    sweep = [{"hex": "x", **AMMAN, "alt_baro": 3000, "gs": 180}, REAL]
    assert len(drop_sentinel_fixes(sweep)) == 2


def test_the_same_airframe_reported_twice_is_not_a_sentinel():
    # A duplicate row for one aircraft is ordinary. It is two IDENTITIES that cannot share a spot.
    sweep = [{"hex": "dup", **AMMAN, "gs": 400, "alt_baro": 30000},
             {"hex": "dup", **AMMAN, "gs": 400, "alt_baro": 30000}]
    assert len(drop_sentinel_fixes(sweep)) == 2


def test_rows_without_an_identity_still_count_as_separate_claimants():
    sweep = [{**AMMAN, "gs": 400, "alt_baro": 30000}, {**AMMAN, "gs": 410, "alt_baro": 31000}]
    assert drop_sentinel_fixes(sweep) == []


def test_keys_on_callsign_when_that_is_all_the_table_has():
    # aircraft_last_seen has no hex column to group by.
    sweep = [{"callsign": "ABY352", **AMMAN}, {"callsign": "JZR174", **AMMAN}]
    assert drop_sentinel_fixes(sweep, key="callsign") == []


# ── Corridor geometry ─────────────────────────────────────────────────────────

def test_path_ends_are_exact():
    path = great_circle_path(DAM, KWI)
    assert interpolate_path(path, 0.0) == DAM
    assert interpolate_path(path, 1.0) == KWI


def test_beyond_the_ends_it_pins_rather_than_extrapolating():
    path = great_circle_path(DAM, KWI)
    assert interpolate_path(path, -5) == DAM
    assert interpolate_path(path, 99) == KWI


def test_midpoint_is_on_the_great_circle_not_the_straight_line():
    # The whole reason for slerp. On DAM-DXB the spherical midpoint sits measurably off the
    # naive average, and drawing the average puts an aircraft beside its own route.
    path = great_circle_path(DAM, DXB)
    lat, lon = interpolate_path(path, 0.5)
    naive_lat = (DAM[0] + DXB[0]) / 2
    assert lat != naive_lat
    assert abs(lat - naive_lat) < 0.5       # same neighbourhood, different point
    assert DXB[0] < lat < DAM[0]
    assert DAM[1] < lon < DXB[1]


def test_waypoint_fractions_are_respected():
    # A corridor whose middle waypoint is reached at 10% of the flight, not 50%. Ignoring the
    # stored fraction would put the aircraft in the wrong place on every bunched route.
    path = [{"lat": 0, "lon": 0, "f": 0.0},
            {"lat": 10, "lon": 0, "f": 0.1},
            {"lat": 20, "lon": 0, "f": 1.0}]
    lat, _ = interpolate_path(path, 0.1)
    assert abs(lat - 10) < 0.01
    lat_mid, _ = interpolate_path(path, 0.55)
    assert 14 < lat_mid < 16, "halfway between the second and third waypoints"


def test_bearing_points_along_the_route():
    south_east = bearing_from_path(great_circle_path(DAM, KWI), 0.5)
    assert 90 < south_east < 180, south_east
    north_west = bearing_from_path(great_circle_path(KWI, DAM), 0.5)
    assert 270 < north_west < 360, north_west


def test_bearing_is_continuous_through_a_waypoint():
    # Sampling either side rather than taking the enclosing segment. A snap here is what made
    # the nose and the motion disagree by 57 degrees on approach.
    path = [{"lat": 0, "lon": 0, "f": 0.0},
            {"lat": 5, "lon": 5, "f": 0.5},
            {"lat": 10, "lon": 5, "f": 1.0}]
    before = bearing_from_path(path, 0.49)
    after = bearing_from_path(path, 0.51)
    assert abs(before - after) < 60, (before, after)


def test_empty_and_degenerate_paths_return_nothing():
    assert interpolate_path([], 0.5) is None
    assert bearing_from_path([], 0.5) is None
    assert interpolate_path([{"lat": 1, "lon": 1}], 0.5) == (1, 1)


# ── Projection ────────────────────────────────────────────────────────────────

PATH = great_circle_path(DAM, KWI)
DEP = T0
ARR = T0 + 2 * HOUR


def test_at_departure_over_the_origin_at_arrival_over_the_destination():
    a = project_position(DEP, ARR, PATH, DEP)
    assert abs(a["lat"] - DAM[0]) < 0.01 and abs(a["lon"] - DAM[1]) < 0.01
    b = project_position(DEP, ARR, PATH, ARR)
    assert abs(b["lat"] - KWI[0]) < 0.01 and abs(b["lon"] - KWI[1]) < 0.01


def test_halfway_is_between_the_two_and_pointing_the_right_way():
    p = project_position(DEP, ARR, PATH, DEP + HOUR)
    assert KWI[0] < p["lat"] < DAM[0]
    assert DAM[1] < p["lon"] < KWI[1]
    assert 90 < p["track_deg"] < 180
    assert abs(p["fraction"] - 0.5) < 1e-9


def test_it_is_a_function_of_its_inputs_and_nothing_else():
    # The property no client tracker could offer: two callers at one instant agree, and asking
    # again cannot move anything, because there is no state to move.
    t = DEP + 1_234_567
    assert project_position(DEP, ARR, PATH, t) == project_position(DEP, ARR, PATH, t)


def test_a_later_eta_slows_the_aeroplane_rather_than_teleporting_it():
    # A delay absorbed into eta_stable_utc has to reach the marker, or the aircraft arrives on
    # the map while the countdown still has twenty minutes to run.
    t = DEP + HOUR
    on_time = project_position(DEP, ARR, PATH, t)
    delayed = project_position(DEP, ARR + HOUR, PATH, t)
    assert delayed["fraction"] < on_time["fraction"]
    assert abs(delayed["fraction"] - 1 / 3) < 1e-9


def test_before_departure_it_waits_at_the_gate():
    p = project_position(DEP, ARR, PATH, DEP - HOUR)
    assert abs(p["lat"] - DAM[0]) < 0.01, "not reversing back down the corridor"
    assert p["fraction"] == 0.0


def test_after_arrival_it_stays_at_the_destination():
    p = project_position(DEP, ARR, PATH, ARR + 5 * HOUR)
    assert abs(p["lat"] - KWI[0]) < 0.01, "not continuing past Kuwait"
    assert p["fraction"] == 1.0


def test_nonsense_schedules_produce_nothing_rather_than_a_wrong_answer():
    assert project_position(None, ARR, PATH, DEP) is None
    assert project_position(float("nan"), ARR, PATH, DEP) is None
    assert project_position(ARR, DEP, PATH, DEP) is None, "arrival before departure"
    assert project_position(DEP, DEP, PATH, DEP) is None, "zero-length flight"
    assert project_position(DEP, ARR, [], DEP) is None, "no corridor"


def test_a_real_corridor_is_followed_not_the_direct_line():
    # DAM->SHJ is stored via Saudi Arabia and often flown via Iraq. If the stored corridor were
    # ignored in favour of a straight line, the marker would sit hundreds of km off the airway —
    # which is the defect the web works around by pinning ghosts near the destination.
    dogleg = [{"lat": 33.4, "lon": 36.5, "f": 0.0},
              {"lat": 30.0, "lon": 44.0, "f": 0.5},
              {"lat": 25.3, "lon": 55.4, "f": 1.0}]
    p = project_position(DEP, ARR, dogleg, DEP + HOUR)
    assert abs(p["lat"] - 30.0) < 0.01 and abs(p["lon"] - 44.0) < 0.01
    direct = project_position(DEP, ARR, great_circle_path((33.4, 36.5), (25.3, 55.4)), DEP + HOUR)
    assert math.hypot(p["lat"] - direct["lat"], p["lon"] - direct["lon"]) > 1.0


# ── The projection window ─────────────────────────────────────────────────────

LINGER = 30 * 60 * 1000


def test_a_just_landed_flight_is_still_drawn():
    assert within_projection_window(ARR, ARR + 5 * 60_000, LINGER)


def test_a_flight_long_past_its_arrival_is_not():
    # Otherwise it pins at the destination airport and sits there until midnight, which is
    # exactly the "arrived markers never expire" defect on the web's schedule overlay.
    assert not within_projection_window(ARR, ARR + LINGER + 1, LINGER)


def test_the_boundary_belongs_to_the_flight():
    assert within_projection_window(ARR, ARR + LINGER, LINGER)


def test_an_unknown_arrival_keeps_the_flight():
    # The schedule is what is in doubt, not the aeroplane. Dropping it would hide a real flight
    # because we failed to work out when it lands.
    assert within_projection_window(None, ARR + 10 * LINGER, LINGER)
    assert within_projection_window(float("nan"), ARR + 10 * LINGER, LINGER)


def test_before_arrival_it_is_obviously_in_the_window():
    assert within_projection_window(ARR, DEP, LINGER)


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

"""
The ported tracker, against the behaviour that made it worth porting.

Run:  python3 services/flight-api/test_path_tracker.py

Stateful by design, so every test drives it with an explicit clock. Nothing here reads the
real time — a test that did would be untestable for exactly the reason the client trackers were.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from geo import haversine_km
from path_tracker import PathTracker, TrackerStore, synthesize_path

MIN = 60_000
HOUR = 3_600_000
T0 = 1_755_340_800_000

DAM = (33.411, 36.514)
DXB = (25.253, 55.365)
AMM = (31.7226, 35.9932)

# DXB -> DAM, the direction FDB1113 flies.
CTX = {
    "variants": [],
    "dep_coords": DXB,
    "arr_coords": DAM,
    "departed_at_ms": T0,
    "eta_ms": T0 + 3 * HOUR,
    "duration_ms": 3 * HOUR,
}


def at(tracker, ms):
    return tracker.position(ms)


def km_between(p, q):
    return haversine_km((p["lat"], p["lon"]), (q[0], q[1]))


# ── The mechanism itself ──────────────────────────────────────────────────────

def test_the_corridor_owns_the_position():
    """
    The whole point. A fix does not set the marker; it corrects the rate.

    KNE591 on 16 Aug was served parked at Queen Alia while it was on final at Damascus. The
    website never drew it there because of this rule, and the first version of this service —
    which took the freshest fix — did.
    """
    t = PathTracker(dict(CTX), T0)
    before = at(t, T0 + 90 * MIN)
    # A fix claiming the aircraft is at Amman, hundreds of km off a DXB-DAM corridor.
    t.apply_fix({"lat": AMM[0], "lon": AMM[1], "at_ms": T0 + 90 * MIN, "gs_kts": 10}, T0 + 90 * MIN)
    after = at(t, T0 + 90 * MIN)
    assert km_between(after, (before["lat"], before["lon"])) < 1, "the marker did not move to Amman"
    assert t.rejects["off_path"] == 1


def test_it_advances_between_fixes():
    # Position is a function of the clock, not of polling. This is what makes a 10 s poll
    # invisible and what the app lost when it stopped animating live flights.
    t = PathTracker(dict(CTX), T0)
    a = at(t, T0 + 30 * MIN)
    b = at(t, T0 + 60 * MIN)
    assert b["route_fraction"] > a["route_fraction"]
    assert km_between(b, (a["lat"], a["lon"])) > 100


def test_progress_is_seeded_from_elapsed_time():
    # A tracker built mid-flight starts where the schedule says, not at the gate.
    t = PathTracker(dict(CTX), T0 + 90 * MIN)
    assert abs(t.s - 0.5) < 0.01


def test_an_on_corridor_fix_is_accepted_and_steers_the_rate():
    t = PathTracker(dict(CTX), T0)
    p = at(t, T0 + 60 * MIN)
    out = t.apply_fix({"lat": p["lat"], "lon": p["lon"], "at_ms": T0 + 60 * MIN, "gs_kts": 430},
                      T0 + 60 * MIN)
    assert out["accepted"], out
    assert t.rejects["off_path"] == 0


# ── The bug the website's copy still has ──────────────────────────────────────

def test_a_tracker_that_ran_ahead_can_come_back():
    """
    The reason this port carries the app's version rather than the website's.

    With `s` monotonic under a rate floor a tracker that has overshot its aircraft can only
    grow the error. Measured on the TypeScript, a tracker seeded 298 km ahead grew to 440 km
    over 40 polls in the website's copy and closed to 61 km in the app's.

    Two corroborating fixes are required before it moves — one is noise, two is news — so this
    feeds several.
    """
    t = PathTracker(dict(CTX), T0)
    t.s = 0.60                                   # forced ahead of the aircraft
    t.v = t._nominal_rate(T0)

    truth = 0.30
    geo = t.geo
    lat, lon = geo.position_at(truth)

    errors = []
    now = T0
    for i in range(12):
        now += 30_000
        t.apply_fix({"lat": lat, "lon": lon, "at_ms": now, "gs_kts": 400}, now)
        errors.append(t.s - truth)

    assert errors[-1] < errors[0], f"error grew: {errors[0]:.3f} -> {errors[-1]:.3f}"
    assert t.rejects["backward"] >= 1, "the first backward fix should have been refused as noise"


def test_the_correction_is_bled_in_not_applied_at_once():
    # A marker that jumped backwards would be worse than one that is ahead.
    t = PathTracker(dict(CTX), T0)
    t.s = 0.60
    geo = t.geo
    lat, lon = geo.position_at(0.30)
    now = T0
    for _ in range(3):
        now += 30_000
        t.apply_fix({"lat": lat, "lon": lon, "at_ms": now, "gs_kts": 400}, now)
    jump = 0.60 - t.s
    assert jump < 0.15, f"moved {jump:.3f} of the route in one step"
    assert t.pending_correction_s > 0, "the rest is still owed"


# ── Where we diverge from the website, deliberately ───────────────────────────

def test_a_flight_with_no_departure_signal_seeds_from_its_first_fix():
    """
    FDB1192 ALP-DXB, 16 Aug: climbing through 25,900 ft at 425 knots with FR24 publishing no
    departure at all. The website had not started it. We start on speed and altitude, so there
    is no elapsed time to seed from and the first fix has to do it.
    """
    ctx = dict(CTX, departed_at_ms=None, eta_ms=T0 + 3 * HOUR)
    t = PathTracker(ctx, T0)
    assert t.s == 0.0 and t.needs_seed

    geo = t.geo
    lat, lon = geo.position_at(0.42)             # found nearly halfway along
    out = t.apply_fix({"lat": lat, "lon": lon, "at_ms": T0, "gs_kts": 425, "altitude_ft": 25900}, T0)

    assert out["accepted"]
    assert abs(t.s - 0.42) < 0.01, "seeded where the fix says, not at the departure gate"
    assert not t.needs_seed


def test_the_unconditional_seed_happens_once_only():
    # After seeding, the ordinary rules apply again — a later off-corridor fix must not move it.
    ctx = dict(CTX, departed_at_ms=None)
    t = PathTracker(ctx, T0)
    geo = t.geo
    lat, lon = geo.position_at(0.42)
    t.apply_fix({"lat": lat, "lon": lon, "at_ms": T0, "gs_kts": 425}, T0)
    before = t.s
    t.apply_fix({"lat": AMM[0], "lon": AMM[1], "at_ms": T0 + MIN, "gs_kts": 10}, T0 + MIN)
    assert abs(t.s - before) < 0.02
    assert t.rejects["off_path"] == 1


# ── Refusals ──────────────────────────────────────────────────────────────────

def test_an_impossible_ground_speed_between_two_fixes_is_refused():
    t = PathTracker(dict(CTX), T0)
    geo = t.geo
    a = geo.position_at(0.20)
    b = geo.position_at(0.80)
    t.apply_fix({"lat": a[0], "lon": a[1], "at_ms": T0, "gs_kts": 400}, T0)
    out = t.apply_fix({"lat": b[0], "lon": b[1], "at_ms": T0 + MIN, "gs_kts": 400}, T0 + MIN)
    assert not out["accepted"] and out["reason"] == "impossible_speed"


def test_a_fix_older_than_the_age_limit_is_refused():
    t = PathTracker(dict(CTX), T0)
    p = at(t, T0 + 60 * MIN)
    out = t.apply_fix({"lat": p["lat"], "lon": p["lon"], "at_ms": T0 - HOUR, "gs_kts": 400},
                      T0 + 60 * MIN)
    assert not out["accepted"] and out["reason"] == "stale"


def test_repeated_off_corridor_fixes_mark_the_flight_diverged():
    t = PathTracker(dict(CTX), T0)
    for i in range(3):
        t.apply_fix({"lat": AMM[0], "lon": AMM[1], "at_ms": T0 + i * MIN, "gs_kts": 400},
                    T0 + i * MIN)
    assert t.mode == "diverged"


def test_is_estimated_tracks_how_long_since_a_fix_was_believed():
    t = PathTracker(dict(CTX), T0)
    assert at(t, T0)["is_estimated"], "nothing has been seen yet"
    p = at(t, T0 + 30 * MIN)
    t.apply_fix({"lat": p["lat"], "lon": p["lon"], "at_ms": T0 + 30 * MIN, "gs_kts": 430},
                T0 + 30 * MIN)
    assert not at(t, T0 + 31 * MIN)["is_estimated"]
    assert at(t, T0 + 40 * MIN)["is_estimated"], "past the correction horizon"


# ── The store ─────────────────────────────────────────────────────────────────

def base_input(**kw):
    return {"callsign": "FDB1113", "variants": [], "dep_coords": DXB, "arr_coords": DAM,
            "departed_at_ms": T0, "eta_ms": T0 + 3 * HOUR, "duration_ms": 3 * HOUR, **kw}


def test_the_store_keeps_one_tracker_per_callsign_and_drops_what_it_stops_seeing():
    s = TrackerStore()
    s.update([base_input()], T0)
    assert s.has("FDB1113")
    s.update([], T0 + MIN)
    assert not s.has("FDB1113"), "a flight that leaves the document leaves the store"


def test_a_new_leg_on_the_same_callsign_rebuilds_the_tracker():
    # Progress is monotonic, so carrying the old tracker over would start tomorrow's flight
    # wherever today's finished.
    s = TrackerStore()
    s.update([base_input()], T0)
    s.trackers["FDB1113"].s = 0.9
    s.update([base_input(departed_at_ms=T0 + 12 * HOUR, eta_ms=T0 + 15 * HOUR)], T0 + 12 * HOUR)
    assert s.trackers["FDB1113"].s < 0.1


def test_a_small_eta_change_adjusts_the_rate_without_rebuilding():
    s = TrackerStore()
    s.update([base_input()], T0)
    before = s.trackers["FDB1113"]
    s.update([base_input(eta_ms=T0 + 3 * HOUR + 20 * MIN)], T0 + MIN)
    assert s.trackers["FDB1113"] is before, "a 20-minute delay is not a new flight"


def test_the_same_fix_twice_is_only_applied_once():
    s = TrackerStore()
    fix = {"lat": DXB[0], "lon": DXB[1], "at_ms": T0, "gs_kts": 400}
    s.update([base_input(fix=fix)], T0)
    first = s.trackers["FDB1113"].last_accepted_ms
    s.update([base_input(fix=dict(fix))], T0 + MIN)
    assert s.trackers["FDB1113"].last_accepted_ms == first


def test_a_synthesized_corridor_is_used_when_none_is_stored():
    t = PathTracker(dict(CTX), T0)
    assert t.synthesized
    assert t.geo.usable and t.geo.total_km > 1000


def test_a_stored_corridor_is_preferred_and_followed():
    dogleg = synthesize_path(DXB, DAM)
    dogleg.insert(len(dogleg) // 2, {"f": 0.5, "lat": 30.0, "lon": 44.0})
    t = PathTracker(dict(CTX, variants=[dogleg]), T0)
    assert not t.synthesized


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

"""
derive_phase, against the cases that were wrong.

Run:  python3 services/flight-api/test_phase.py

Pure — (flight row, position) in, a word out — so this needs no database and no app.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("SUPABASE_URL", "https://example.invalid")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test")

from main import derive_phase


def test_fdb1192_climbing_out_of_aleppo_is_not_scheduled():
    """
    16 Aug, verbatim from /v2/live. FR24 had filed no departure, so every branch that waits for
    real_dep fell through and the document called a climbing aeroplane "scheduled" while its own
    progress field read 7% and its ETA read 15:13.
    """
    f = {"real_dep": None, "real_arr": None}
    pos = {"lat": 34.84, "lon": 37.25, "altitude_ft": 25900, "ground_speed_kts": 425,
           "vertical_speed_fpm": 1728, "on_ground": False}
    assert derive_phase(f, pos) == "en_route"


def test_fyc762_climbing_out_of_sharjah_below_the_old_floor():
    """
    17 Aug, verbatim. 1,125 ft and 182 knots with on_ground false on every fix from two
    independent sources, called "scheduled" for 55 seconds because 1,125 is under the old
    5,000 ft floor. FR24's departure reached us at 01:50:00; the aircraft was demonstrably
    flying at 01:49:05.
    """
    f = {"real_dep": None, "real_arr": None}
    pos = {"altitude_ft": 1125, "ground_speed_kts": 182, "on_ground": False}
    assert derive_phase(f, pos) == "en_route"


def test_an_explicit_airborne_flag_is_believed_at_any_height():
    f = {"real_dep": None, "real_arr": None}
    assert derive_phase(f, {"altitude_ft": 300, "ground_speed_kts": 160, "on_ground": False}) == "en_route"


def test_a_fix_that_says_it_is_on_the_ground_is_never_promoted():
    # The take-off roll: fast, low, and still on the runway. 16 such fixes in 24 hours.
    f = {"real_dep": None, "real_arr": None}
    pos = {"altitude_ft": 2020, "ground_speed_kts": 140, "on_ground": True}
    assert derive_phase(f, pos) == "taxiing"


def test_without_the_flag_it_falls_back_to_the_altitude_floor():
    # 0.2% of fixes omit on_ground. Silence is not evidence of flight.
    f = {"real_dep": None, "real_arr": None}
    assert derive_phase(f, {"altitude_ft": 200, "ground_speed_kts": 160}) == "scheduled"
    assert derive_phase(f, {"altitude_ft": 900, "ground_speed_kts": 160}) == "en_route"


def test_a_published_departure_still_wins():
    f = {"real_dep": "2026-08-16T11:35:00Z", "real_arr": None}
    assert derive_phase(f, {"on_ground": False, "ground_speed_kts": 420}) == "en_route"
    assert derive_phase(f, None) == "departed"


def test_taxiing_is_not_promoted():
    # The failure mode to avoid: an aircraft on a taxiway called en_route because nobody
    # published a departure. 15 knots at field elevation is not flying.
    f = {"real_dep": None, "real_arr": None}
    assert derive_phase(f, {"on_ground": True, "ground_speed_kts": 15, "altitude_ft": 1280}) == "taxiing"


def test_the_take_off_roll_stays_conservative():
    # Fast but low. It reads taxiing for a few more seconds rather than claiming cruise, which
    # is the safe direction for a rule that must never claim more than the position supports.
    f = {"real_dep": None, "real_arr": None}
    pos = {"on_ground": True, "ground_speed_kts": 140, "altitude_ft": 1300}
    assert derive_phase(f, pos) == "taxiing"


def test_parked_with_no_departure_is_still_scheduled():
    f = {"real_dep": None, "real_arr": None}
    assert derive_phase(f, {"on_ground": True, "ground_speed_kts": 0, "altitude_ft": 1280}) == "scheduled"
    assert derive_phase(f, None) == "scheduled"


DOWN = {"real_dep": "2026-08-17T01:27:09Z", "real_arr": None}
CONFIRMED = {"real_dep": "2026-08-17T01:27:09Z", "real_arr": "2026-08-17T02:24:16Z"}


def ground(gs, **kw):
    return {"on_ground": True, "altitude_ft": 0, "ground_speed_kts": gs, **kw}


# ── The four stages a person waiting actually experiences ─────────────────────

def test_rollout_is_landed():
    # Wheels down, still fast. The moment someone at the window sees it touch.
    assert derive_phase(DOWN, ground(120)) == "landed"
    assert derive_phase(CONFIRMED, ground(120)) == "landed"


def test_crossing_the_airfield_is_taxi_to_gate():
    assert derive_phase(DOWN, ground(22)) == "taxi_to_gate"
    assert derive_phase(CONFIRMED, ground(8)) == "taxi_to_gate"


def test_stopped_without_a_landing_on_the_record_is_at_gate():
    # We watched it stop, and that is worth saying. Ending the flight's life is a claim about a
    # record we do not have.
    assert derive_phase(DOWN, ground(0)) == "at_gate"


def test_stopped_with_the_landing_on_the_record_is_arrived():
    # The terminal state, and the only one that needs the published signal.
    assert derive_phase(CONFIRMED, ground(0)) == "arrived"


def test_the_boundary_between_rollout_and_taxi_is_fifty_knots():
    # The same number the departure rule uses for "faster than any taxi", so the file has one
    # boundary rather than two.
    assert derive_phase(DOWN, ground(50)) == "landed"
    assert derive_phase(DOWN, ground(49)) == "taxi_to_gate"


def test_a_crawl_counts_as_stopped():
    # GPS noise on a parked aircraft. Three knots is not crossing an airfield.
    assert derive_phase(CONFIRMED, ground(3)) == "arrived"
    assert derive_phase(CONFIRMED, ground(4)) == "taxi_to_gate"


def test_the_belt_beats_the_gate_but_not_the_taxi():
    # It is the last thing published and the thing a person waiting came for — VF341 got CAR4
    # twenty minutes after landing. But a moving aircraft has not reached a belt.
    assert derive_phase(dict(CONFIRMED, arr_baggage="CAR4"), ground(0)) == "bags_on_belt"
    assert derive_phase(dict(CONFIRMED, arr_baggage="CAR4"), ground(22)) == "taxi_to_gate"


def test_confirmed_down_with_no_position_is_arrived():
    # No fix to say which stage; the coarser word, as ever.
    assert derive_phase(CONFIRMED, None) == "arrived"


def test_rja431_would_no_longer_read_departed_on_the_ground():
    """
    Into Aleppo, 17 Aug: on the ground for five minutes reading `departed`, because every
    arrival branch waited for real_arr — which landed at 02:24:16.
    """
    assert derive_phase(DOWN, ground(22)) != "departed"
    assert derive_phase(DOWN, ground(0)) != "departed"


def test_airborne_after_departure_is_unaffected():
    assert derive_phase(DOWN, {"on_ground": False, "ground_speed_kts": 460,
                               "altitude_ft": 34000}) == "en_route"


def test_a_confirmed_arrival_beats_a_fix_that_still_looks_airborne():
    # Contradictory data: the record says it landed, the fix says 25,900 ft. The record wins,
    # and with no ground position to say which stage, the terminal word is the honest one.
    f = {"real_dep": None, "real_arr": "2026-08-16T15:10:00Z"}
    assert derive_phase(f, {"on_ground": False, "ground_speed_kts": 425, "altitude_ft": 25900}) == "arrived"


def test_cancelled_and_diverted_still_win_over_everything():
    for outcome in ("cancelled", "diverted"):
        f = {"outcome": outcome, "real_dep": None, "real_arr": None}
        pos = {"on_ground": False, "ground_speed_kts": 425, "altitude_ft": 25900}
        assert derive_phase(f, pos) == outcome


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

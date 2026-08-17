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


def test_an_arrival_is_untouched_by_any_of_this():
    f = {"real_dep": None, "real_arr": "2026-08-16T15:10:00Z"}
    assert derive_phase(f, {"on_ground": False, "ground_speed_kts": 425, "altitude_ft": 25900}) == "landed"


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

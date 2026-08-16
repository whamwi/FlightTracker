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

"""
Choosing which FR24 instance our own reception belongs to.

Run:  python3 services/fr24-harvester/test_instance_pick.py

Pure — a sweep in, a callsign map out. harvester.py reads Supabase credentials at import, so
they are stubbed below rather than required; nothing here touches a network or a database.
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("SUPABASE_URL", "http://stub")
os.environ.setdefault("SUPABASE_ANON_KEY", "stub")

sys.path.insert(0, str(Path(__file__).parent))

from harvester import instances_by_callsign          # noqa: E402

# seen maps fr24_id -> (row, callsign, is_live, arrived)
YESTERDAY = ("413362a6", (7, "RJA437", False, True))     # landed 13:05:25Z on the 16th
TODAY_LIVE = ("4137688c", (3, "RJA437", True, False))    # today's, airborne
TODAY_FILED = ("4137688c", (3, "RJA437", False, False))  # today's, filed but not yet flying


def test_a_finished_flight_is_never_the_aeroplane_we_are_hearing():
    """
    The RJ437 case, verbatim. It left Amman at 13:21:32Z on 17 Aug, FR24 had not yet published
    today's instance, and yesterday's arrived instance was the only candidate. Ranking put it
    last and then used it anyway, because any rank beats an empty map — so for eight minutes our
    receivers' view of today's aeroplane was filed under a flight that landed the day before.
    """
    assert instances_by_callsign(dict([YESTERDAY])) == {}, "no id is better than the wrong id"


def test_the_live_instance_wins_when_both_are_present():
    picked = instances_by_callsign(dict([YESTERDAY, TODAY_LIVE]))
    assert picked["RJA437"] == ("4137688c", 3)


def test_order_of_the_sweep_does_not_decide_it():
    # Pages arrive in whatever order; the answer must not depend on that.
    a = instances_by_callsign(dict([YESTERDAY, TODAY_LIVE]))
    b = instances_by_callsign(dict([TODAY_LIVE, YESTERDAY]))
    assert a == b


def test_a_flight_not_yet_airborne_still_beats_nothing():
    """
    Filed but not yet flying is a legitimate answer — the receiver sees an aircraft before FR24
    decides to track it, which is the whole reason we run our own.
    """
    picked = instances_by_callsign(dict([TODAY_FILED]))
    assert picked["RJA437"] == ("4137688c", 3)


def test_airborne_beats_filed_but_not_yet_flying():
    other = ("41400001", (9, "RJA437", False, False))
    picked = instances_by_callsign(dict([other, TODAY_LIVE]))
    assert picked["RJA437"] == ("4137688c", 3)


def test_an_instance_with_no_callsign_is_not_indexed():
    assert instances_by_callsign({"41400002": (1, None, True, False)}) == {}
    assert instances_by_callsign({"41400003": (1, "", True, False)}) == {}


def test_unrelated_callsigns_are_all_kept():
    picked = instances_by_callsign({
        "a1": (1, "RJA437", True, False),
        "b2": (2, "FYC702", True, False),
        "c3": (3, "SYR441", False, False),
    })
    assert set(picked) == {"RJA437", "FYC702", "SYR441"}


def test_a_day_of_finished_legs_yields_nothing_at_all():
    # Every instance of this callsign has arrived. There is nothing live to attribute a fix to,
    # and inventing one is what this function exists to prevent.
    picked = instances_by_callsign({
        "d1": (1, "SYR444", False, True),
        "d2": (2, "SYR444", False, True),
    })
    assert picked == {}


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

"""
Which board rows may be bound to a live aircraft.

Run:  python3 services/flight-api/test_live_leg.py

Pure — a row and a clock in, a yes or no out.
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from main import ARRIVED_LINGER_SEC, STALE_UNARRIVED_SEC, is_live_leg

NOW = datetime(2026, 8, 17, 13, 24, 8, tzinfo=timezone.utc)


def z(dt: datetime) -> str:
    return dt.isoformat()


def test_yesterdays_finished_leg_is_not_todays_aeroplane():
    """
    The RJA437 case, verbatim. Scheduled out of Amman 10:55Z on the 17th, actually airborne at
    13:21Z — two and a half hours late. The 16 Aug row had already landed at 13:05:25Z the day
    before, and this service bound the live aircraft to it for ten minutes, giving it yesterday's
    schedule and yesterday's ETA.
    """
    yesterday = {"flight_date": "2026-08-16", "iata_number": "RJ437",
                 "sched_dep": "2026-08-16T12:20:00+00:00",
                 "real_dep": "2026-08-16T12:31:25+00:00",
                 "real_arr": "2026-08-16T13:05:25+00:00"}
    assert is_live_leg(yesterday, NOW) is False


def test_todays_leg_is_kept_however_late_it_is():
    today = {"flight_date": "2026-08-17", "iata_number": "RJ437",
             "sched_dep": "2026-08-17T10:55:00+00:00",
             "real_dep": "2026-08-17T13:21:32+00:00", "real_arr": None}
    assert is_live_leg(today, NOW) is True


def test_a_flight_that_has_not_departed_is_kept():
    # Tomorrow's row, waiting. Nothing about it is closed.
    assert is_live_leg({"sched_dep": z(NOW + timedelta(hours=18)),
                        "real_dep": None, "real_arr": None}, NOW) is True


def test_a_row_with_no_times_at_all_is_kept():
    # Missing information is not grounds for deletion; something else will judge it.
    assert is_live_leg({}, NOW) is True


# ── The arrival window ────────────────────────────────────────────────────────

def test_a_flight_that_has_just_landed_stays():
    """
    The ground phases — landed, taxi_to_gate, at_gate, bags_on_belt — all describe an aircraft
    that has stopped producing fixes. Dropping it on touchdown would take every one of them.
    """
    just_down = {"real_arr": z(NOW - timedelta(seconds=ARRIVED_LINGER_SEC - 60))}
    assert is_live_leg(just_down, NOW) is True


def test_a_flight_that_landed_before_the_window_is_dropped():
    old = {"real_arr": z(NOW - timedelta(seconds=ARRIVED_LINGER_SEC + 60))}
    assert is_live_leg(old, NOW) is False


def test_our_own_confirmation_counts_as_an_arrival():
    # Aleppo is silent on most arrivals, so arr_confirmed_at is the only close for those legs.
    assert is_live_leg({"arr_confirmed_at": z(NOW - timedelta(hours=6))}, NOW) is False
    assert is_live_leg({"arr_confirmed_at": z(NOW - timedelta(minutes=5))}, NOW) is True


def test_the_later_of_the_two_arrival_columns_decides():
    """
    A flight can close by both routes. If FR24 published an arrival hours ago but we only
    confirmed it a minute ago, the row is still fresh and its belt is still worth showing.
    """
    both = {"real_arr": z(NOW - timedelta(hours=4)),
            "arr_confirmed_at": z(NOW - timedelta(minutes=1))}
    assert is_live_leg(both, NOW) is True


# ── Rows that never close ─────────────────────────────────────────────────────

def test_a_leg_left_open_for_ever_stops_being_live():
    """
    FR24 does not always publish an arrival — 35 legs in a fortnight — so a row can sit with
    real_arr null indefinitely. An open row is exactly what a recycled fr24_id or a repeated
    callsign latches onto days later.
    """
    ghost = {"sched_dep": z(NOW - timedelta(seconds=STALE_UNARRIVED_SEC + 3600)),
             "real_dep": z(NOW - timedelta(seconds=STALE_UNARRIVED_SEC + 3600)),
             "real_arr": None}
    assert is_live_leg(ghost, NOW) is False


def test_the_longest_route_we_fly_is_comfortably_inside_the_window():
    # DAM-SVO is 280 minutes. A rule that expired mid-flight would be worse than no rule.
    airborne = {"real_dep": z(NOW - timedelta(minutes=280)), "real_arr": None}
    assert is_live_leg(airborne, NOW) is True


def test_a_long_delay_does_not_expire_a_flight_that_is_still_flying():
    # Six hours late and airborne is a bad day, not a stale row.
    assert is_live_leg({"sched_dep": z(NOW - timedelta(hours=9)),
                        "real_dep": z(NOW - timedelta(hours=3)),
                        "real_arr": None}, NOW) is True


def test_the_actual_departure_is_preferred_over_the_scheduled_one():
    """
    A flight scheduled 17 hours ago but airborne for one is live; judged on its schedule alone it
    would sit a single hour from being discarded mid-flight.
    """
    f = {"sched_dep": z(NOW - timedelta(hours=17)),
         "real_dep": z(NOW - timedelta(hours=1)), "real_arr": None}
    assert is_live_leg(f, NOW) is True


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

"""
Folding a confirmed arrival into the live document.

Run:  python3 services/flight-api/test_arrival_wiring.py

The poller is I/O and is not tested here. What is tested is the two pure decisions around it:
which flights get asked about, and what a confirmation does to a row once it comes back.
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import main
from arrivals import POLL_FROM_MS, POLL_UNTIL_MS, awaiting_arrival
from main import apply_confirmed_arrivals, derive_phase, eta_key

NOW_MS = 1786957508 * 1000
ETA = NOW_MS


def flight(**kw) -> dict:
    base = {"flight_date": "2026-08-17", "iata_number": "XH701", "callsign": "FYC701",
            "dep_iata": "DAM", "arr_iata": "KWI",
            "real_dep": "2026-08-17T09:00:00+00:00", "real_arr": None,
            "arr_confirmed_at": None, "sched_arr_ms": ETA}
    base.update(kw)
    return base


HIT = {"arrived_at": "2026-08-17T09:05:08+00:00", "arrived_at_ms": 1786957508 * 1000,
       "source": "fr24_flight_status", "precise": False, "status_text": "Landed 12:05"}


# ── Who gets asked ────────────────────────────────────────────────────────────

def test_a_flight_in_the_air_near_its_arrival_is_asked_about():
    assert awaiting_arrival(flight(), NOW_MS) is True


def test_a_flight_that_has_not_departed_is_not_asked_about():
    # Nothing to confirm. Asking would spend a request to learn the schedule we already have.
    assert awaiting_arrival(flight(real_dep=None), NOW_MS) is False


def test_a_flight_already_closed_is_not_asked_about():
    assert awaiting_arrival(flight(real_arr="2026-08-17T09:05:08+00:00"), NOW_MS) is False
    assert awaiting_arrival(flight(arr_confirmed_at="2026-08-17T09:05:08+00:00"), NOW_MS) is False


def test_it_starts_asking_before_the_scheduled_arrival():
    # FYC701 was on the ground 25 minutes early; an on-schedule window would have missed it.
    assert awaiting_arrival(flight(sched_arr_ms=NOW_MS + POLL_FROM_MS - 60_000), NOW_MS) is True


def test_it_does_not_ask_hours_ahead_of_time():
    assert awaiting_arrival(flight(sched_arr_ms=NOW_MS + 5 * 3600_000), NOW_MS) is False


def test_it_gives_up_a_couple_of_hours_after_the_arrival():
    assert awaiting_arrival(flight(sched_arr_ms=NOW_MS - POLL_UNTIL_MS - 60_000), NOW_MS) is False


def test_the_estimate_is_preferred_over_the_schedule():
    # RJA437 left Amman 2h26m late. Judged on its original slot it would be asked about, and
    # given up on, before it had landed.
    late = flight(sched_arr_ms=NOW_MS - 5 * 3600_000, est_arr_ms=NOW_MS)
    assert awaiting_arrival(late, NOW_MS) is True


def test_a_flight_with_no_arrival_time_at_all_is_skipped():
    f = flight(); f.pop("sched_arr_ms")
    assert awaiting_arrival(f, NOW_MS) is False


# ── What a confirmation does ──────────────────────────────────────────────────

def setup_function(_=None):
    main._arr_confirmed.clear()


def test_a_confirmation_lands_in_the_column_derive_phase_already_reads():
    """
    Expressed as arr_confirmed_at rather than a new field, so the whole ground ladder keeps
    working with no knowledge that this source exists.
    """
    main._arr_confirmed.clear()
    f = flight()
    main._arr_confirmed[eta_key(f)] = HIT
    out = apply_confirmed_arrivals([f])[0]
    assert out["arr_confirmed_at"] == "2026-08-17T09:05:08+00:00"
    assert out["arr_confirmed_src"] == "fr24_flight_status"


def test_a_flight_nobody_confirmed_is_left_exactly_as_it_was():
    main._arr_confirmed.clear()
    f = flight()
    assert apply_confirmed_arrivals([f])[0] == f


def test_fr24s_own_timestamp_is_never_overwritten():
    """
    Where both exist they agree exactly — 25 of 25 control legs within a minute — but the
    published timestamp beats a time read out of prose, so it wins on principle as well.
    """
    main._arr_confirmed.clear()
    f = flight(real_arr="2026-08-17T09:04:00+00:00")
    main._arr_confirmed[eta_key(f)] = HIT
    out = apply_confirmed_arrivals([f])[0]
    assert out["real_arr"] == "2026-08-17T09:04:00+00:00"
    assert out.get("arr_confirmed_at") is None


def test_the_row_is_copied_not_mutated():
    # The poller's dict is shared state; editing a caller's row in place is how one request
    # starts changing another's.
    main._arr_confirmed.clear()
    f = flight()
    apply_confirmed_arrivals([f])
    assert f.get("arr_confirmed_at") is None


def test_a_confirmation_for_a_different_day_does_not_apply():
    # eta_key carries the date. Yesterday's confirmation must not close today's leg — the RJA437
    # lesson, in the other direction.
    main._arr_confirmed.clear()
    main._arr_confirmed[eta_key(flight(flight_date="2026-08-16"))] = HIT
    out = apply_confirmed_arrivals([flight()])[0]
    assert out.get("arr_confirmed_at") is None


# ── The trust order, end to end ───────────────────────────────────────────────

def test_a_live_fix_still_decides_what_the_aircraft_is_doing():
    """
    Confirmed down AND rolling out is `landed`, not `arrived`. The confirmation ends the flight's
    record; the fix says where it is in the landing. FYC781's published arrival beat our own
    350 ft fix by 22 seconds, and `arrived` would have been a lie in that window.
    """
    main._arr_confirmed.clear()
    f = flight()
    main._arr_confirmed[eta_key(f)] = HIT
    row = apply_confirmed_arrivals([f])[0]
    rolling = {"on_ground": True, "ground_speed_kts": 80}
    assert derive_phase(row, rolling, None, NOW_MS) == "landed"


def test_a_confirmation_is_what_turns_a_stopped_aeroplane_into_arrived():
    main._arr_confirmed.clear()
    f = flight()
    stopped = {"on_ground": True, "ground_speed_kts": 0}
    assert derive_phase(f, stopped, None, NOW_MS) == "at_gate", "nothing has confirmed it"
    main._arr_confirmed[eta_key(f)] = HIT
    row = apply_confirmed_arrivals([f])[0]
    assert derive_phase(row, stopped, None, NOW_MS) == "arrived"


def test_with_no_fix_at_all_the_confirmation_is_the_only_thing_that_can_end_it():
    """
    The whole reason this exists. Kuwait has no receiver within 60 nm, so a flight landing there
    produces no fix — and without a confirmation it would fly for ever.
    """
    main._arr_confirmed.clear()
    f = flight()
    assert derive_phase(f, None, None, NOW_MS) == "departed"
    main._arr_confirmed[eta_key(f)] = HIT
    row = apply_confirmed_arrivals([f])[0]
    assert derive_phase(row, None, None, NOW_MS) == "arrived"


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            main._arr_confirmed.clear()
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as e:
                fails += 1
                print(f"FAIL {name}: {e}")
    print(f"\n{fails} failed")
    sys.exit(1 if fails else 0)

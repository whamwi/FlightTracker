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
from main import (FUTURE_ARRIVAL_GRACE_MS, apply_confirmed_arrivals, derive_phase,
                  eta_key, persist_arrival, plausible_arrival)

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


def test_a_flight_we_never_saw_depart_is_still_asked_about():
    """
    This required a recorded departure at first, and that was backwards. Of 35 unconfirmed legs in
    a fortnight, 32 have no real_dep — a flight we never saw leave is the one we know LEAST about,
    and gating on the departure skipped 91% of the rows this exists to close.

    Nothing is risked by asking: confirm_arrival matches on date and route and accepts only an
    explicit landing, so a flight that never operated returns None.
    """
    assert awaiting_arrival(flight(real_dep=None), NOW_MS) is True


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


# ── Before it becomes a fact on the website ───────────────────────────────────

def test_an_arrival_in_the_past_is_plausible():
    assert plausible_arrival(HIT, NOW_MS + 600_000) is True


def test_an_arrival_in_the_future_is_refused():
    """
    status_arrival chooses between three candidate days, so a badly-placed text could resolve
    ahead of the clock. This is the last thing between that and a row on the website.
    """
    future = dict(HIT, arrived_at_ms=NOW_MS + FUTURE_ARRIVAL_GRACE_MS + 60_000)
    assert plausible_arrival(future, NOW_MS) is False


def test_a_touchdown_a_moment_from_now_is_tolerated():
    # Clocks are not perfectly aligned; a few seconds either way is not an error.
    close = dict(HIT, arrived_at_ms=NOW_MS + 60_000)
    assert plausible_arrival(close, NOW_MS) is True


def test_an_arrival_with_no_timestamp_is_refused():
    assert plausible_arrival({"arrived_at": "x"}, NOW_MS) is False


# ── The write ─────────────────────────────────────────────────────────────────

class FakePatch:
    """Records the request instead of making it."""
    def __init__(self, status=200, body=None):
        self.status, self.body, self.calls = status, body if body is not None else [{}], []

    async def patch(self, url, headers=None, json=None, timeout=None):
        self.calls.append({"url": url, "json": json})
        class R:
            status_code = self.status
            def json(_): return self.body
        return R()


def test_the_write_targets_one_row_and_only_while_it_is_unconfirmed():
    """
    The two null filters are load-bearing. They make this a compare-and-set, so a real arrival
    published between the poll and the write is not overwritten by a time read out of prose.
    """
    import asyncio
    c = FakePatch()
    f = flight()
    assert asyncio.run(persist_arrival(c, f, HIT)) is True
    url = c.calls[0]["url"]
    for expected in ("flight_date=eq.2026-08-17", "iata_number=eq.XH701",
                     "dep_iata=eq.DAM", "arr_iata=eq.KWI",
                     "real_arr=is.null", "arr_confirmed_at=is.null"):
        assert expected in url, expected
    assert c.calls[0]["json"] == {"arr_confirmed_at": HIT["arrived_at"],
                                  "arr_confirmed_src": "fr24_flight_status"}


def test_losing_the_race_is_reported_as_not_written():
    # Zero rows matched: something better got there first. Not an error, and not a write.
    import asyncio
    c = FakePatch(body=[])
    assert asyncio.run(persist_arrival(c, flight(), HIT)) is False


def test_an_error_from_the_database_is_not_a_write():
    import asyncio
    c = FakePatch(status=409)
    assert asyncio.run(persist_arrival(c, flight(), HIT)) is False


def test_a_row_that_cannot_be_addressed_is_not_written():
    # Without the full identity the filter could match more than one leg.
    import asyncio
    c = FakePatch()
    assert asyncio.run(persist_arrival(c, flight(iata_number=None), HIT)) is False
    assert c.calls == [], "nothing was sent"


def test_readonly_mode_writes_nothing():
    import asyncio
    c = FakePatch()
    main.FLIGHT_API_READONLY = True
    try:
        assert asyncio.run(persist_arrival(c, flight(), HIT)) is False
        assert c.calls == []
    finally:
        main.FLIGHT_API_READONLY = False


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

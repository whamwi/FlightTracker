"""
Asking FR24 about one flight.

Run:  python3 services/flight-api/test_arrivals.py

Everything here is pure — legs in, a verdict out — so none of it touches the network. The fetch
around it is I/O and is not tested here.
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from arrivals import (LEG_TOLERANCE_MS, arrival_of, flight_url, normalise_number, parse_legs,
                      pick_leg, query_forms, status_arrival)

DAY = 86_400
# FYC701's real list, trimmed. Verbatim from 17 Aug: scheduled 09:30Z daily, on the ground at
# 09:05Z on the 17th — twenty-five minutes early — and nothing at all recorded for the 16th.
TODAY_ARR = 1786959000          # 17 Aug 09:30Z scheduled
LEGS = [
    {"number": "FYC701", "dep_iata": "DAM", "arr_iata": "KWI",
     "sched_arrival": TODAY_ARR + 2 * DAY, "real_arrival": None,
     "real_departure": None, "status": "Scheduled"},
    {"number": "FYC701", "dep_iata": "DAM", "arr_iata": "KWI",
     "sched_arrival": TODAY_ARR + DAY, "real_arrival": None,
     "real_departure": None, "status": "Scheduled"},
    {"number": "FYC701", "dep_iata": "DAM", "arr_iata": "KWI",
     "sched_arrival": TODAY_ARR, "real_arrival": 1786957508,
     "real_departure": 1786945000, "status": "Landed 12:05"},
    {"number": "FYC701", "dep_iata": "DAM", "arr_iata": "KWI",
     "sched_arrival": TODAY_ARR - DAY, "real_arrival": None,
     "real_departure": None, "status": "Unknown"},
    {"number": "FYC701", "dep_iata": "DAM", "arr_iata": "KWI",
     "sched_arrival": TODAY_ARR - 2 * DAY, "real_arrival": 1786870380,
     "real_departure": None, "status": "Landed 11:53"},
]

OURS = {"iata_number": "XH701", "callsign": "FYC701", "dep_iata": "DAM", "arr_iata": "KWI",
        "sched_arr_ms": TODAY_ARR * 1000}


# ── Identity ──────────────────────────────────────────────────────────────────

def test_padding_and_spacing_do_not_break_a_match():
    assert normalise_number("RB 0441") == "RB441"
    assert normalise_number("RB0441") == "RB441"
    assert normalise_number("RB441") == "RB441"


def test_an_empty_number_is_no_number():
    assert normalise_number(None) is None
    assert normalise_number("") is None


def test_both_identity_forms_are_asked_about():
    """
    Which form FR24 indexes is decided per airline and cannot be predicted. Measured 17 Aug, all
    HTTP 200: FYC701 returned 14 rows and XH701 zero; RB441 returned a row and SYR441 zero.
    Asking only one form would return nothing for half the fleet — and nothing from this source
    is indistinguishable from "has not landed".
    """
    assert query_forms(OURS) == ["FYC701", "XH701"]
    assert query_forms({"iata_number": "RB441", "callsign": "SYR441"}) == ["SYR441", "RB441"]


def test_a_flight_with_only_one_name_asks_once():
    assert query_forms({"iata_number": "RB272"}) == ["RB272"]


def test_the_same_name_twice_is_not_two_questions():
    assert query_forms({"iata_number": "RB272", "callsign": "RB 0272"}) == ["RB272"]


def test_a_flight_with_no_identifiers_is_not_guessed_at():
    assert query_forms({"dep_iata": "DAM"}) == []


# ── Picking the right date ────────────────────────────────────────────────────

def test_todays_leg_is_chosen_from_a_list_of_many_dates():
    """
    The list holds a week of future schedule and a fortnight of history for the same number. If
    the date is not pinned, last week's landing gets reported as today's.
    """
    leg = pick_leg(LEGS, "DAM", "KWI", TODAY_ARR * 1000)
    assert leg["real_arrival"] == 1786957508
    assert leg["status"] == "Landed 12:05"


def test_a_leg_on_another_date_is_not_todays_arrival():
    # Asking about the 16th, which FR24 recorded as Unknown, must not return the 17th's landing.
    leg = pick_leg(LEGS, "DAM", "KWI", (TODAY_ARR - DAY) * 1000)
    assert leg is not None and leg["real_arrival"] is None
    assert arrival_of(leg) is None


def test_the_nearest_leg_wins_when_two_are_within_tolerance():
    # A delayed flight can sit closer to the next day's slot than its own. Nearest, not first.
    leg = pick_leg(LEGS, "DAM", "KWI", (TODAY_ARR + DAY - 3600) * 1000)
    assert leg["sched_arrival"] == TODAY_ARR + DAY


def test_a_date_nothing_is_near_returns_nothing():
    assert pick_leg(LEGS, "DAM", "KWI", (TODAY_ARR + 30 * DAY) * 1000) is None


def test_a_delayed_leg_inside_the_tolerance_is_still_found():
    late = (TODAY_ARR * 1000) - LEG_TOLERANCE_MS + 60_000
    assert pick_leg(LEGS, "DAM", "KWI", late) is not None


def test_the_same_number_on_a_different_route_is_a_different_flight():
    assert pick_leg(LEGS, "DAM", "AUH", TODAY_ARR * 1000) is None


def test_a_leg_with_no_route_recorded_still_matches_on_the_date():
    # Missing information is not a contradiction.
    legs = [dict(LEGS[2], dep_iata=None, arr_iata=None)]
    assert pick_leg(legs, "DAM", "KWI", TODAY_ARR * 1000) is not None


# ── What counts as evidence ───────────────────────────────────────────────────

def test_a_confirmed_touchdown_is_reported_with_its_time():
    hit = arrival_of(pick_leg(LEGS, "DAM", "KWI", TODAY_ARR * 1000))
    assert hit["arrived_at_ms"] == 1786957508 * 1000
    assert hit["arrived_at"] == "2026-08-17T09:05:08+00:00"
    assert hit["source"] == "fr24_flight"
    assert hit["status_text"] == "Landed 12:05"


def test_a_scheduled_leg_is_not_an_arrival():
    assert arrival_of(LEGS[0]) is None


def test_nothing_at_all_is_not_an_arrival():
    """
    None means "FR24 does not tell us", never "it did not land". A caller reading this as a
    negative would un-land flights whenever FR24 publishes late, and the marker would resurrect.
    """
    assert arrival_of(None) is None


# ── The request ───────────────────────────────────────────────────────────────

def test_the_query_asks_for_one_flight_not_an_airport():
    url = flight_url("FYC701")
    assert "query=FYC701" in url and "fetchBy=flight" in url


def test_enough_rows_are_asked_for_to_see_past_the_future_schedule():
    """
    The list arrives newest-first and a daily service has a week of scheduled legs on the front of
    it. limit=5 saw nothing but schedule; 25 reached six days back for 26 KB.
    """
    import arrivals
    assert arrivals.DEFAULT_LIMIT >= 15
    assert f"limit={arrivals.DEFAULT_LIMIT}" in flight_url("FYC701")


# ── Shape changes ─────────────────────────────────────────────────────────────

def test_an_unrecognisable_payload_is_empty_not_an_exception():
    # It is an undocumented endpoint. When it changes shape this should go quiet rather than take
    # the service down.
    assert parse_legs({}) == []
    assert parse_legs({"result": {"response": None}}) == []
    assert parse_legs({"result": {"response": {"data": None}}}) == []


def test_a_real_payload_shape_is_flattened():
    payload = {"result": {"response": {"data": [
        {"identification": {"number": {"default": "FYC701"}},
         "airport": {"origin": {"code": {"iata": "DAM"}},
                     "destination": {"code": {"iata": "KWI"}}},
         "time": {"scheduled": {"arrival": TODAY_ARR}, "real": {"arrival": 1786957508}},
         "status": {"text": "Landed 12:05"}}
    ]}}}
    legs = parse_legs(payload)
    assert len(legs) == 1
    assert legs[0]["dep_iata"] == "DAM" and legs[0]["arr_iata"] == "KWI"
    assert legs[0]["real_arrival"] == 1786957508


# ── The arrival written in prose ──────────────────────────────────────────────

ALP = 3.0          # Aleppo, UTC+3


def test_the_time_is_read_out_of_the_status_when_the_field_is_empty():
    """
    FR24 does not always fill time.real.arrival, and on Syrian arrivals it usually does not — but
    the status still says so in words. Reading only the numeric field scored 0 of 45 on exactly
    the legs we most need; with this it scored 28.

        TK844 into Aleppo, 12 Aug:  real —  "Landed 09:35"
    """
    leg = {"sched_arrival": 1786772700, "real_arrival": None, "status": "Landed 09:35"}
    t = status_arrival(leg, ALP)
    assert t is not None
    assert datetime.fromtimestamp(t, timezone.utc).strftime("%H:%M") == "06:35", "local -> UTC"


def test_the_text_agrees_with_the_field_when_both_are_present():
    """
    Measured across 41 legs carrying both: 40 agreed within a minute. Same event, two spellings.

    TK844 into Aleppo on 16 Aug, verbatim: scheduled 06:45Z, real 06:38Z, "Landed 09:38".
    """
    day = 1786752000                                   # a midnight UTC
    leg = {"sched_arrival": day + 6 * 3600 + 45 * 60,
           "real_arrival":  day + 6 * 3600 + 38 * 60,
           "status": "Landed 09:38"}
    assert abs(status_arrival(leg, ALP) - leg["real_arrival"]) <= 60


def test_a_landing_after_midnight_belongs_to_the_next_day():
    # Scheduled 23:50 local, on the ground 00:15. Anchored naively this lands 24 hours out.
    sched = 1786772700 - (1786772700 % 86400) + (23 * 3600 + 50 * 60) - int(ALP * 3600)
    t = status_arrival({"sched_arrival": sched, "real_arrival": None,
                        "status": "Landed 00:15"}, ALP)
    assert 0 < t - sched < 3600, "just after the schedule, not a day before it"


def test_an_arrival_that_would_precede_its_departure_is_declined():
    """
    The text is dated to the day the flight ACTUALLY arrived; we can only anchor on the day it was
    SCHEDULED to. A leg running a day late resolves to the wrong day — RB272 into Amsterdam came
    out 1,441 minutes early, the only failure in 41 legs. The departure is what exposes it, and
    declining is the contract: a wrong arrival time is worse than an absent one.
    """
    leg = {"sched_arrival": 1786772700, "real_arrival": None, "status": "Landed 09:35",
           "real_departure": 1786772700 + 86400}
    assert status_arrival(leg, ALP) is None


def test_a_status_that_is_not_a_landing_yields_no_time():
    for text in ("Scheduled", "Unknown", "Estimated 13:10", "Canceled", "Landed", ""):
        assert status_arrival({"sched_arrival": 1786772700, "status": text}, ALP) is None


def test_an_impossible_clock_time_is_rejected():
    assert status_arrival({"sched_arrival": 1786772700, "status": "Landed 25:99"}, ALP) is None


def test_without_the_airports_offset_the_text_cannot_be_placed():
    # Better to decline than to assert a time three hours wrong.
    assert status_arrival({"sched_arrival": 1786772700, "status": "Landed 09:35"}, None) is None


def test_a_time_from_prose_is_flagged_as_less_precise_than_a_timestamp():
    # A caller weighing this against ADS-B needs to know which of the two it is holding.
    numeric = arrival_of({"sched_arrival": 1786772700, "real_arrival": 1786768680,
                          "status": "Landed 09:38"}, ALP)
    prose = arrival_of({"sched_arrival": 1786772700, "real_arrival": None,
                        "status": "Landed 09:35"}, ALP)
    assert numeric["precise"] is True and numeric["source"] == "fr24_flight"
    assert prose["precise"] is False and prose["source"] == "fr24_flight_status"


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

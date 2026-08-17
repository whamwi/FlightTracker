"""
Reading an arrival off the destination airport's board.

Run:  python3 services/flight-api/test_arrivals.py

Everything here is pure — a board in, a verdict out, `now` a parameter — so none of it touches
the network. The fetch around it is I/O and is not tested here.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from arrivals import (LOOKBACK_MS, MAX_LIMIT, MIN_LIMIT, POLL_FROM_MS, POLL_UNTIL_MS,
                      airports_due, flight_identities, limit_for, match_arrival,
                      normalise_number, note_density, parse_arrivals, widget_url)

# The board FR24 served for Kuwait on 17 Aug, trimmed to the rows that matter. FYC701's numbers
# are verbatim: scheduled 12:30 Damascus, on the ground at 12:05, twenty-five minutes early.
FYC701 = {"number": "FYC701", "callsign": "FYC701", "origin": "DAM",
          "real_arrival": 1786957508, "sched_arrival": 1786959000, "status": "Landed 12:05"}
KWI_BOARD = [
    {"number": "J91312", "callsign": "JZR1312", "origin": "TZX",
     "real_arrival": 1786956840, "sched_arrival": 1786958700, "status": "Landed 10:54"},
    FYC701,
    {"number": "KU286", "callsign": "KAC286", "origin": "DAC",
     "real_arrival": None, "sched_arrival": 1786962600, "status": "Estimated 13:10"},
]

OURS = {"iata_number": "XH701", "callsign": "FYC701", "dep_iata": "DAM", "arr_iata": "KWI"}


# ── Identity ──────────────────────────────────────────────────────────────────

def test_padding_and_spacing_do_not_break_a_match():
    # FR24 writes the same flight three ways. An exact string compare drops real arrivals.
    assert normalise_number("RB 0441") == "RB441"
    assert normalise_number("RB0441") == "RB441"
    assert normalise_number("RB441") == "RB441"


def test_an_empty_number_is_no_number():
    assert normalise_number(None) is None
    assert normalise_number("") is None


def test_a_flight_is_known_by_both_of_its_names():
    # The trap that has cost this project three bugs in one day.
    assert flight_identities(OURS) == {"XH701", "FYC701"}


def test_the_icao_form_on_their_board_matches_the_iata_form_on_ours():
    """
    The KWI board called it FYC701. Our route_master calls it XH701. Matching on iata_number
    alone would have missed the exact flight that proved this source works.
    """
    hit = match_arrival(OURS, KWI_BOARD)
    assert hit is not None, "matched on the callsign form"
    assert hit["arrived_at_ms"] == 1786957508 * 1000
    assert hit["source"] == "fr24_widget"
    assert hit["status_text"] == "Landed 12:05"


# ── What counts as evidence ───────────────────────────────────────────────────

def test_an_estimate_is_not_an_arrival():
    # KU286 is on the board with a time, but it is an estimate. Treating that as a touchdown
    # would land flights that are still an hour out.
    kuwait_airways = {"iata_number": "KU286", "callsign": "KAC286",
                      "dep_iata": "DAC", "arr_iata": "KWI"}
    assert match_arrival(kuwait_airways, KWI_BOARD) is None


def test_a_flight_the_board_does_not_mention_returns_nothing():
    """
    None means "the board does not tell us", never "it did not land". A caller that read this as
    a negative would un-land flights whenever FR24 publishes late, and the marker would resurrect.
    """
    assert match_arrival({"iata_number": "RB441", "callsign": "SYR441",
                          "dep_iata": "DAM", "arr_iata": "KWI"}, KWI_BOARD) is None


def test_yesterdays_leg_with_the_same_number_is_not_todays_arrival():
    # A flight number is unique per airline per day, and a board spanning midnight has both legs
    # on it. The origin is what tells them apart.
    from_somewhere_else = dict(OURS, dep_iata="AUH")
    assert match_arrival(from_somewhere_else, KWI_BOARD) is None


def test_a_board_with_no_origin_recorded_still_matches_on_the_number():
    # Missing origin is missing information, not a contradiction.
    board = [dict(FYC701, origin=None)]
    assert match_arrival(OURS, board) is not None


def test_a_flight_with_no_identifiers_at_all_is_not_guessed_at():
    assert match_arrival({"dep_iata": "DAM", "arr_iata": "KWI"}, KWI_BOARD) is None


# ── Which airports get asked ──────────────────────────────────────────────────

NOW = 1786957508 * 1000


def test_an_airport_is_asked_from_an_hour_before_the_arrival():
    f = {"arr_iata": "KWI", "sched_arr_ms": NOW + POLL_FROM_MS - 60_000}
    assert "KWI" in airports_due([f], NOW)


def test_an_airport_is_not_asked_long_before_the_flight_is_due():
    f = {"arr_iata": "DXB", "sched_arr_ms": NOW + 6 * 3600_000}
    assert airports_due([f], NOW) == {}


def test_asking_stops_some_hours_after_the_flight_should_have_arrived():
    # Otherwise a flight FR24 never publishes keeps its airport in the sweep forever.
    f = {"arr_iata": "DXB", "sched_arr_ms": NOW - POLL_UNTIL_MS - 60_000}
    assert airports_due([f], NOW) == {}


def test_a_confirmed_arrival_stops_being_asked_about():
    f = {"arr_iata": "KWI", "sched_arr_ms": NOW, "arrived_at": "2026-08-17T09:05:08+00:00"}
    assert airports_due([f], NOW) == {}


def test_two_flights_into_one_airport_are_one_question():
    # 29 airports in route_master; asking per-flight rather than per-airport is how a pass turns
    # into megabytes of the same board.
    due = airports_due([{"arr_iata": "KWI", "sched_arr_ms": NOW + 600_000},
                        {"arr_iata": "KWI", "sched_arr_ms": NOW}], NOW)
    assert list(due) == ["KWI"]
    assert due["KWI"] == NOW, "anchored on the earlier of the two"


def test_the_estimate_is_preferred_over_the_schedule_when_deciding_to_ask():
    # A flight running three hours late should be asked about late, not on its original slot.
    f = {"arr_iata": "KWI", "sched_arr_ms": NOW - 5 * 3600_000, "est_arr_ms": NOW}
    assert "KWI" in airports_due([f], NOW)


# ── The request ───────────────────────────────────────────────────────────────

def test_the_window_is_anchored_on_now_not_on_midnight():
    """
    A hundred rows from local midnight run out long before an evening arrival at Dubai. The page
    this borrows from uses midnight, which is fine at Deir ez-Zor and useless at a hub.
    """
    url = widget_url("DXB", NOW)
    assert f"[timestamp]={int((NOW - LOOKBACK_MS) / 1000)}" in url
    assert "code=DXB" in url


def test_a_quiet_airport_is_asked_for_few_rows_and_a_busy_one_for_many():
    """
    Measured 17 Aug: 20 rows is 4.3 h at Kuwait and 0.3 h at Istanbul. One constant cannot serve
    both — it either wastes most of a megabyte or covers twenty minutes.
    """
    note_density("KWI", [{"sched_arrival": 0}, {"sched_arrival": 4 * 3600}] +
                        [{"sched_arrival": i * 800} for i in range(18)])
    note_density("IST", [{"sched_arrival": i * 12} for i in range(100)])   # ~0.3 h of board
    assert limit_for("KWI") < limit_for("IST")
    assert limit_for("IST") == MAX_LIMIT, "a hub is asked for everything it will give"
    assert limit_for("KWI") == MIN_LIMIT, "and a quiet stand costs the floor"


def test_the_row_count_never_exceeds_what_the_endpoint_allows():
    # limit=200 is answered with HTTP 400 and no rows at all, which would blind us entirely.
    note_density("XXX", [{"sched_arrival": i} for i in range(100)])
    assert limit_for("XXX") <= MAX_LIMIT


def test_an_airport_that_has_never_answered_still_gets_a_sane_request():
    assert MIN_LIMIT <= limit_for("NEVER_SEEN") <= MAX_LIMIT


def test_a_board_too_thin_to_measure_does_not_poison_the_density():
    # Deir ez-Zor returns zero arrival rows: FR24 knows the airport but lists no schedule for it.
    # One row, or none, is not a span, and dividing by it would be a fabricated number.
    before = limit_for("DEZ")
    note_density("DEZ", [])
    note_density("DEZ", [{"sched_arrival": 12345}])
    assert limit_for("DEZ") == before


# ── Shape changes ─────────────────────────────────────────────────────────────

def test_an_unrecognisable_payload_is_empty_not_an_exception():
    # It is an undocumented endpoint. It will change shape one day, and when it does this should
    # go quiet rather than take the service down.
    assert parse_arrivals({}) == []
    assert parse_arrivals({"result": {"response": None}}) == []


def test_a_real_payload_shape_is_flattened():
    payload = {"result": {"response": {"airport": {"pluginData": {"schedule": {"arrivals": {"data": [
        {"flight": {"identification": {"number": {"default": "FYC701"}, "callsign": "FYC701"},
                    "airport": {"origin": {"code": {"iata": "DAM"}}},
                    "time": {"real": {"arrival": 1786957508},
                             "scheduled": {"arrival": 1786959000}},
                    "status": {"text": "Landed 12:05"}}}
    ]}}}}}}}
    rows = parse_arrivals(payload)
    assert len(rows) == 1
    assert rows[0]["number"] == "FYC701" and rows[0]["origin"] == "DAM"
    assert rows[0]["real_arrival"] == 1786957508


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

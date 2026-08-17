"""
Turning one aggregator record into a position.

Run:  python3 services/flight-api/test_adsb.py

to_position is pure — record in, position out, `now` a parameter — so none of this touches the
network. The sweep around it is I/O and is not tested here.
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from adsb import to_position

NOW = datetime(2026, 8, 17, 3, 0, 0, tzinfo=timezone.utc)


def age_of(pos) -> float:
    return (NOW - datetime.fromisoformat(pos["fix_at"])).total_seconds()


# ── Position age, not message age ─────────────────────────────────────────────

def test_the_position_age_is_used_not_the_message_age():
    """
    ABY265, 17 Aug: seen 0.1s, seen_pos 33.3s. The aircraft was transmitting continuously and
    its COORDINATE was half a minute old. Stamping that as current is what made a marker sit
    still and then leap — ABY433 moved 0.0 km in 52 seconds and then 22.8 km in 26.
    """
    p = to_position({"lat": 1, "lon": 2, "seen": 0.1, "seen_pos": 33.3}, None, NOW)
    assert abs(age_of(p) - 33.3) < 0.01, "stamped from seen_pos"


def test_it_falls_back_to_the_message_age_when_there_is_no_position_age():
    p = to_position({"lat": 1, "lon": 2, "seen": 12.0}, None, NOW)
    assert abs(age_of(p) - 12.0) < 0.01


def test_a_record_with_neither_age_is_treated_as_current():
    # Not ideal, but the alternative is discarding a position we can see. Every aircraft in the
    # Syria circle carried both fields when measured, so this is the theoretical case.
    p = to_position({"lat": 1, "lon": 2}, None, NOW)
    assert abs(age_of(p)) < 0.01


def test_a_non_numeric_age_does_not_poison_the_timestamp():
    p = to_position({"lat": 1, "lon": 2, "seen_pos": "x", "seen": None}, None, NOW)
    assert abs(age_of(p)) < 0.01


# ── Carrying heading and speed forward ────────────────────────────────────────

PREV = {"ground_speed_kts": 490, "track_deg": 91}


def test_a_missing_track_is_carried_from_the_last_one():
    """
    FYC486 at 02:51:54, verbatim: a position at 29,025 ft with no gs and no track, nineteen
    seconds after a fix reading 490 kt on 091. The map drew it stationary and pointing north,
    because a missing track renders as zero.
    """
    p = to_position({"lat": 35.2, "lon": 35.8, "alt_baro": 29025, "seen_pos": 1}, PREV, NOW)
    assert p["track_deg"] == 91
    assert p["ground_speed_kts"] == 490
    assert set(p["carried"]) == {"gs", "track"}


def test_a_reported_value_always_wins_over_a_remembered_one():
    p = to_position({"lat": 1, "lon": 2, "gs": 474, "track": 126, "seen_pos": 1}, PREV, NOW)
    assert p["ground_speed_kts"] == 474 and p["track_deg"] == 126
    assert p["carried"] is None


def test_only_the_missing_half_is_carried():
    p = to_position({"lat": 1, "lon": 2, "gs": 474, "seen_pos": 1}, PREV, NOW)
    assert p["ground_speed_kts"] == 474, "reported"
    assert p["track_deg"] == 91, "remembered"
    assert p["carried"] == ["track"]


def test_a_genuine_zero_is_not_treated_as_missing():
    # An aircraft stopped on a stand reports gs 0. Carrying 490 forward there would be a lie,
    # and `is None` rather than falsiness is the whole difference.
    p = to_position({"lat": 1, "lon": 2, "gs": 0, "track": 0, "seen_pos": 1}, PREV, NOW)
    assert p["ground_speed_kts"] == 0 and p["track_deg"] == 0
    assert p["carried"] is None


def test_with_no_history_a_missing_value_stays_missing():
    # Nothing to remember. Silence is reported as silence rather than filled with a default,
    # which is what the renderer must handle.
    p = to_position({"lat": 1, "lon": 2, "seen_pos": 1}, None, NOW)
    assert p["ground_speed_kts"] is None and p["track_deg"] is None


# ── The ground encoding ───────────────────────────────────────────────────────

def test_the_ground_string_becomes_zero_feet_and_an_explicit_flag():
    p = to_position({"lat": 1, "lon": 2, "alt_baro": "ground", "gs": 12, "seen_pos": 0}, None, NOW)
    assert p["altitude_ft"] == 0
    assert p["on_ground"] is True


def test_a_numeric_zero_is_the_ground_too():
    """
    THY848 into Damascus, 17 Aug: alt 0 ft at 48 kt then 13 kt, taxiing to the gate. The
    aggregators usually spell this as the string "ground", but a numeric 0 was being mapped to
    on_ground False — the opposite of what the record means. No aircraft in this network
    reports 0 ft pressure altitude while flying.
    """
    p = to_position({"lat": 33.43, "lon": 36.52, "alt_baro": 0, "gs": 13, "seen_pos": 1}, None, NOW)
    assert p["on_ground"] is True
    assert p["altitude_ft"] == 0


def test_a_slightly_negative_pressure_altitude_is_also_the_ground():
    # Pressure altitude is referenced to 1013 hPa and reads negative at a sea-level airport in
    # high pressure. Still a parked aeroplane.
    p = to_position({"lat": 25.25, "lon": 55.36, "alt_baro": -75, "gs": 0, "seen_pos": 1}, None, NOW)
    assert p["on_ground"] is True


def test_a_take_off_roll_at_zero_feet_is_not_promoted_to_airborne():
    # Fast and still on the runway. on_ground True is what stops derive_phase calling it
    # en_route before it rotates.
    p = to_position({"lat": 33.41, "lon": 36.51, "alt_baro": 0, "gs": 140, "seen_pos": 0}, None, NOW)
    assert p["on_ground"] is True


def test_a_real_altitude_means_explicitly_not_on_the_ground():
    # The field derive_phase leans on to call a departure the moment an aircraft rotates.
    p = to_position({"lat": 1, "lon": 2, "alt_baro": 1125, "gs": 182, "seen_pos": 0}, None, NOW)
    assert p["on_ground"] is False
    assert p["altitude_ft"] == 1125


def test_an_absent_altitude_leaves_the_ground_question_open():
    p = to_position({"lat": 1, "lon": 2, "gs": 182, "seen_pos": 0}, None, NOW)
    assert p["altitude_ft"] is None
    assert p["on_ground"] is None, "unknown, not false"


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

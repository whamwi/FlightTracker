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

from main import derive_phase, note_ground_state, carry_vector, LANDED_LATCH_MS
import main as _main


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


# ── Keeping the last heading ──────────────────────────────────────────────────

def reset_vectors():
    _main._last_vector.clear()


def test_a_reported_heading_is_passed_through_and_remembered():
    reset_vectors()
    p = carry_vector("X", {"lat": 27.29, "lon": 48.99, "track_deg": 300, "ground_speed_kts": 470})
    assert p["track_deg"] == 300 and p["ground_speed_kts"] == 470
    assert p.get("carried") is None, "nothing was remembered, it was reported"


def test_a_silent_fix_keeps_the_last_heading():
    """
    FYC782 MCT-DAM, 17 Aug: a position at 34,000 ft reading "track —, gs — kt". The renderer
    defaults a missing track to zero, so the marker snapped due north while the aeroplane was
    flying south-west. It reaches us through the FR24 table, which adsb.py never sees.
    """
    reset_vectors()
    carry_vector("FYC782", {"lat": 27.29, "lon": 48.99, "track_deg": 300, "ground_speed_kts": 470})
    p = carry_vector("FYC782", {"lat": 27.10, "lon": 48.70})
    assert p["track_deg"] == 300
    assert p["ground_speed_kts"] == 470
    assert set(p["carried"]) == {"track", "gs"}


def test_only_the_missing_half_is_carried():
    reset_vectors()
    carry_vector("X", {"track_deg": 300, "ground_speed_kts": 470})
    p = carry_vector("X", {"track_deg": 310})
    assert p["track_deg"] == 310, "reported wins"
    assert p["ground_speed_kts"] == 470, "remembered"
    assert p["carried"] == ["gs"]


def test_a_carried_value_does_not_become_the_next_source():
    # Otherwise one silent fix pins the heading for the rest of the flight, with nothing able to
    # correct it — a remembered value would keep re-remembering itself.
    reset_vectors()
    carry_vector("X", {"track_deg": 300})
    carry_vector("X", {})                     # carries 300, must not re-store it as reported
    assert _main._last_vector["X"] == {"track_deg": 300}


def test_a_genuine_zero_is_not_treated_as_missing():
    # An aircraft stopped on a stand reports gs 0 and track 0. Carrying 470 there would be a lie.
    reset_vectors()
    carry_vector("X", {"track_deg": 300, "ground_speed_kts": 470})
    p = carry_vector("X", {"track_deg": 0, "ground_speed_kts": 0})
    assert p["track_deg"] == 0 and p["ground_speed_kts"] == 0
    assert p.get("carried") is None


def test_with_no_history_the_gap_stays_a_gap():
    # Silence reported as silence. The renderer must handle it rather than be handed a default.
    reset_vectors()
    p = carry_vector("NEW", {"lat": 1, "lon": 2})
    assert p.get("track_deg") is None and p.get("carried") is None


def test_no_callsign_and_no_position_are_left_alone():
    reset_vectors()
    assert carry_vector("", {"track_deg": 1}) == {"track_deg": 1}
    assert carry_vector("X", None) is None


# ── The touchdown latch ───────────────────────────────────────────────────────

T0 = 1_755_400_000_000


def reset_latch():
    _main._ground_since.clear()
    _main._seen_airborne.clear()


def test_the_transition_is_remembered_only_for_something_seen_flying():
    reset_latch()
    # First sighting is already on the ground: we did not watch it land, so we must not say so.
    assert note_ground_state("PARKED", True, T0) is None
    # Seen airborne, then on the ground: that is a landing, and the instant is kept.
    assert note_ground_state("FLYER", False, T0) is None
    assert note_ground_state("FLYER", True, T0 + 1000) == T0 + 1000
    # And it does not move on later ground fixes.
    assert note_ground_state("FLYER", True, T0 + 9000) == T0 + 1000


def test_going_airborne_again_clears_it():
    # A go-around, or tomorrow's leg on the same callsign.
    reset_latch()
    note_ground_state("X", False, T0)
    note_ground_state("X", True, T0 + 1000)
    assert note_ground_state("X", False, T0 + 2000) is None
    assert note_ground_state("X", True, T0 + 3000) == T0 + 3000


def test_an_unknown_ground_state_neither_sets_nor_clears():
    reset_latch()
    note_ground_state("Y", False, T0)
    note_ground_state("Y", True, T0 + 1000)
    assert note_ground_state("Y", None, T0 + 2000) == T0 + 1000, "silence is not evidence"


def test_a_brisk_rollout_still_shows_landed():
    """
    FYC781 into Muscat, 17 Aug: airborne at 350 ft and 108 kt, then 0 ft and 25.5 kt seventeen
    seconds later. The whole roll fitted in one gap, so the speed test never saw it above 50 and
    the stage was skipped entirely.
    """
    f = dict(CONFIRMED)
    assert derive_phase(f, ground(25.5), landed_at_ms=T0, now_ms=T0 + 5_000) == "landed"


def test_the_latch_expires_and_the_ladder_resumes():
    f = dict(CONFIRMED)
    just_after = T0 + LANDED_LATCH_MS + 1
    assert derive_phase(f, ground(25.5), landed_at_ms=T0, now_ms=just_after) == "taxi_to_gate"
    assert derive_phase(f, ground(0), landed_at_ms=T0, now_ms=just_after) == "arrived"


def test_without_a_touchdown_instant_nothing_changes():
    # Every existing caller and every case where we never saw it fly.
    f = dict(CONFIRMED)
    assert derive_phase(f, ground(25.5)) == "taxi_to_gate"


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


def test_the_record_can_be_ahead_of_the_aeroplane():
    """
    FR24 published FYC781's landing at 03:40:22 while our fix at 03:40:27 still had it airborne
    at 350 ft. For those 22 seconds `arrived` — stopped at the end of the trip — would be a lie.
    """
    airborne = {"on_ground": False, "altitude_ft": 350, "ground_speed_kts": 108}
    assert derive_phase(CONFIRMED, airborne) == "landed"


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


# ── The map stops drawing an arrival ──────────────────────────────────────────
#
# The rule agreed 18 Aug: the map's job is to track, so a flight leaves it at the terminal
# phase and is looked up on the board or the arrivals panel instead. Everything before
# `arrived` is still motion and still drawn.

def _drawable(phase: str, landed_at=None, now_ms=None):
    """The shipping gate itself, not a copy of it."""
    from main import draws_on_map
    return draws_on_map(phase, landed_at, now_ms)


def test_the_terminal_phase_loses_its_marker():
    assert _drawable("arrived") is False


def test_every_phase_before_arrived_keeps_its_marker():
    # Rolling out, crossing the airfield, and stopped-but-unconfirmed are all still motion,
    # and a passenger meeting the flight wants to see each of them.
    for phase in ("scheduled", "taxiing", "departed", "en_route", "landed", "taxi_to_gate"):
        assert _drawable(phase) is True, phase


def test_at_gate_is_drawn_while_the_record_might_still_arrive():
    now = 1_000_000_000_000
    assert _drawable("at_gate", landed_at=now - 60_000, now_ms=now) is True


def test_at_gate_gives_up_waiting_for_a_record_that_never_comes():
    """
    FR24 is silent on 22 of 35 Aleppo arrivals. Without this the flight sits at its destination
    for STALE_UNARRIVED_SEC — eighteen hours — because is_live_leg only expires on an arrival
    timestamp and `at_gate` has none.
    """
    now = 1_000_000_000_000
    assert _drawable("at_gate", landed_at=now - 31 * 60_000, now_ms=now) is False


def test_at_gate_without_a_landing_time_is_left_alone():
    # No touchdown instant means nothing to measure the grace against; guessing would be worse
    # than drawing it.
    assert _drawable("at_gate", landed_at=None, now_ms=1_000) is True

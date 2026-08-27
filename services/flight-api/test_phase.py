from datetime import datetime, timedelta, timezone
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



# ── A corridor is for flying along ────────────────────────────────────────────

def _on_corridor(path_source, pos=None):
    """The shipping gate itself, not a copy of it."""
    from main import draws_on_corridor
    return draws_on_corridor(path_source, pos)


AIRBORNE = {"lat": 33.4, "lon": 36.5, "on_ground": False}
PARKED = {"lat": 33.41, "lon": 36.52, "on_ground": True,
          "altitude_ft": 0, "ground_speed_kts": 0}


def test_only_a_learned_corridor_is_worth_drawing_on():
    # Measured 26 Aug: learned corridors sit a median 7 km from the fix, stored and
    # great-circle ones 37 to 72. Seventy kilometres is the wrong side of a border.
    assert _on_corridor("learned", AIRBORNE) is True
    assert _on_corridor("stored", AIRBORNE) is False
    assert _on_corridor("great_circle", AIRBORNE) is False
    assert _on_corridor(None, AIRBORNE) is False


def test_an_aircraft_on_the_ground_is_never_flown_along_its_corridor():
    """
    NGN491, 26 Aug: parked at its Damascus stand, publishing motion at 0.000112 per second.

    Had DAM|DUS been a learned corridor rather than a stored one, a client would have walked it
    off the stand toward Düsseldorf hours before pushback. The accuracy gate was hiding this —
    it gave the right answer for a reason that had nothing to do with the aeroplane standing
    still, and would have stopped giving it the day the learner promoted that route.
    """
    assert _on_corridor("learned", PARKED) is False


def test_a_taxiing_aircraft_stays_at_its_fix():
    # It is on a taxiway the corridor knows nothing about, however fast it is moving.
    assert _on_corridor("learned", {**PARKED, "ground_speed_kts": 22}) is False


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


def test_every_phase_between_pushback_and_the_gate_keeps_its_marker():
    # Rolling out, crossing the airfield, and stopped-but-unconfirmed are all still motion,
    # and a passenger meeting the flight wants to see each of them.
    for phase in ("taxiing", "departed", "en_route", "landed", "taxi_to_gate"):
        assert _drawable(phase) is True, phase


def test_bags_on_the_belt_is_as_finished_as_arrived():
    """
    derive_phase returns bags_on_belt INSTEAD of arrived once FR24 publishes the belt, so a rule
    naming only "arrived" let the better-informed state keep its marker. FDB1116 on 27 Aug was
    drawn over the Gulf with its bags already delivered at Dubai.
    """
    assert _drawable("bags_on_belt") is False


def test_a_flight_that_has_not_departed_has_no_marker():
    """
    The same rule as `arrived`, at the other end — and this test used to assert the opposite.

    `scheduled` was in the list above until 26 Aug, when NGN491 DAM-DUS turned up on the map as
    one of ten "observed" flights while parked at its stand: on_ground true, 0 ft, 0 knots, three
    hours before it was due to arrive. FR24 publishes a fix for an aircraft on the ground, and
    nothing here was filtering it.

    A flight that has not left is not traffic. `taxiing` stays drawn, because an aeroplane moving
    under its own power is something happening; the gate is about the ones standing still.
    """
    assert _drawable("scheduled") is False


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


def test_a_stale_fix_does_not_keep_a_confirmed_arrival_flying():
    """
    XH523/FYC523 DAM-EBL, 18 Aug. arr_confirmed_at settled at 18:04, FR24 never published
    real_arr, and Erbil is far outside ADS-B coverage — so the freshest fix was from mid-flight
    over Syria. The board said Arrived and the map drew it airborne hundreds of kilometres away,
    because any fix at all counted as evidence it was still rolling out.

    The contradiction window this branch exists for is 22 seconds. Ten minutes is not it.
    """
    from main import derive_phase
    base = datetime(2026, 8, 18, 18, 10, tzinfo=timezone.utc)   # ten minutes after the landing
    now_ms = base.timestamp() * 1000

    def fix(minutes_old):
        at = base - timedelta(minutes=minutes_old)
        return {"on_ground": False, "altitude_ft": 31000, "ground_speed_kts": 430,
                "fix_at": at.isoformat()}

    assert derive_phase(CONFIRMED, fix(10), None, now_ms) == "arrived", \
        "ten minutes old is not a contradiction, it is an out-of-date fix"
    assert derive_phase(CONFIRMED, fix(0.3), None, now_ms) == "landed", \
        "a fix inside the window still contradicts the record"
    assert derive_phase(CONFIRMED, {"on_ground": False}, None, now_ms) == "landed", \
        "no timestamp means unknown age, and unknown is not stale"


# ── Adoption: learned corridors take precedence over the hand-imported ones ────

def test_the_lookup_order_is_learned_then_stored_then_great_circle():
    """
    The whole of the adoption is an order. A corridor built from five or more real flights by
    THIS operator beats one imported from a single FR24 track years ago, and both beat a straight
    line — but a route with no qualified corridor must fall through to exactly what it drew
    before, so adoption can never make a route worse than it already was.

    Reproduced as the three-step lookup rather than by calling the endpoint, which needs a
    database. The keys are what matter: learned carries the operator, stored does not.
    """
    learned = {"DAM|KWI|JZR": [{"f": 0.5, "lat": 31.0, "lon": 42.0}]}
    stored = {"DAM|KWI": [{"f": 0.5, "lat": 32.0, "lon": 41.0}]}

    def pick(dep, arr, callsign):
        op = (callsign or "")[:3].upper()
        return (learned.get(f"{dep}|{arr}|{op}")
                or stored.get(f"{dep}|{arr}")
                or "great_circle")

    assert pick("DAM", "KWI", "JZR175") is learned["DAM|KWI|JZR"], "learned wins"
    assert pick("DAM", "KWI", "SYR123") is stored["DAM|KWI"], \
        "another operator on the same pair falls back to the stored path, not JZR's corridor"
    assert pick("DAM", "EBL", "FYC521") == "great_circle", "neither, so the straight line"
    assert pick("DAM", "KWI", None) is stored["DAM|KWI"], "no callsign, no operator, no learned"


def test_only_promotable_corridors_are_offered():
    """
    A corridor is written at two flights and is not fit to draw with until it has five — or two
    on a route the filed schedule says can never reach five. The loader filters on exactly that,
    so an unqualified corridor is absent from the map rather than merely ranked lower.
    """
    from learn import is_promotable

    assert is_promotable(5, None)
    assert not is_promotable(4, None), "four flights is still learning"
    assert is_promotable(2, 2), "twice a week qualifies at two"
    assert not is_promotable(2, 7), "daily with two tracks is just new"


# ── Motion: the rate that lands the marker on time ────────────────────────────

def test_the_rate_reaches_one_exactly_at_the_eta():
    """
    The whole reason it is a rate to a deadline rather than a ground speed. A client advancing
    `fraction` by `fraction_per_sec` must arrive at 1.0 as the countdown beside it reaches zero,
    or the marker sits short of the field while the card reads Arrived.
    """
    from datetime import datetime, timedelta, timezone
    from main import motion_of

    now = datetime(2026, 8, 26, 12, 0, tzinfo=timezone.utc)
    eta = now + timedelta(minutes=30)
    m = motion_of(0.4, eta, now.timestamp() * 1000)

    assert m is not None
    travelled = m["fraction_per_sec"] * 1800          # thirty minutes of it
    assert abs((0.4 + travelled) - 1.0) < 1e-6, "lands on 1.0 exactly as the ETA arrives"


def test_a_delay_slows_the_marker_rather_than_teleporting_it():
    """
    The same remaining distance over a longer countdown is a slower marker. This is what makes a
    refresh 'enhance the accuracy to the finish time': each poll re-derives the rate from the
    current ETA, so time made up speeds it and time lost slows it, with no special case.
    """
    from datetime import datetime, timedelta, timezone
    from main import motion_of

    now = datetime(2026, 8, 26, 12, 0, tzinfo=timezone.utc)
    on_time = motion_of(0.5, now + timedelta(minutes=30), now.timestamp() * 1000)
    delayed = motion_of(0.5, now + timedelta(minutes=60), now.timestamp() * 1000)
    assert delayed["fraction_per_sec"] < on_time["fraction_per_sec"]


def test_no_motion_where_there_is_nothing_to_count_toward():
    from datetime import datetime, timedelta, timezone
    from main import motion_of

    now = datetime(2026, 8, 26, 12, 0, tzinfo=timezone.utc)
    ms = now.timestamp() * 1000
    assert motion_of(None, now + timedelta(minutes=10), ms) is None, "no position, no motion"
    assert motion_of(0.5, None, ms) is None, "no ETA, nothing to arrive at"
    assert motion_of(0.5, now - timedelta(minutes=1), ms) is None, \
        "an ETA already past cannot be moved toward"


def test_a_flight_already_there_sits_still():
    from datetime import datetime, timedelta, timezone
    from main import motion_of

    now = datetime(2026, 8, 26, 12, 0, tzinfo=timezone.utc)
    m = motion_of(1.0, now + timedelta(minutes=5), now.timestamp() * 1000)
    assert m["fraction_per_sec"] == 0.0, "nowhere left to go is zero, not a creep"



# ── Corridors reach their airports ────────────────────────────────────────────

def _anchored(path, dep, arr):
    from main import anchored
    return anchored(path, dep, arr)


# (lat, lon) TUPLES — the shape airports() returns. The first version of these tests used dicts,
# which passed happily while the shipped code read dict keys off a tuple and quietly anchored
# nothing. A test that agrees with the code about the wrong contract proves only that they agree.
DAM = (33.4114, 36.5156)
SHJ = (25.3285, 55.5172)


def test_a_learned_corridor_is_extended_to_both_airports():
    """
    Bins are addressed by their CENTRES, so a 40-bin corridor spans 0.0125 to 0.9875 and reaches
    neither end. For DAM-SHJ that left the last waypoint 45 km out over the Gulf, and a client
    clamping to it drew an arriving aircraft over the sea with its nose away from the field.
    """
    learned = [{"f": 0.0125, "lat": 33.2, "lon": 36.8}, {"f": 0.9875, "lat": 25.57, "lon": 55.26}]
    out = _anchored(learned, DAM, SHJ)
    assert out[0]["f"] == 0.0 and out[0]["lat"] == DAM[0] and out[0]["lon"] == DAM[1]
    assert out[-1]["f"] == 1.0 and out[-1]["lat"] == SHJ[0] and out[-1]["lon"] == SHJ[1]
    assert len(out) == 4, "the observed points are kept, not replaced"


def test_a_path_that_already_reaches_the_ends_is_untouched():
    # The stored corridors run 0.0000 to 1.0000 — hand-imported whole tracks. Anchoring them
    # again would add a zero-length first segment whose bearing is undefined.
    stored = [{"f": 0.0, "lat": 33.4114, "lon": 36.5156}, {"f": 1.0, "lat": 25.3285, "lon": 55.5172}]
    assert _anchored(stored, DAM, SHJ) == stored


def test_the_final_segment_then_points_at_the_airport():
    """
    The whole point. Before, the last segment ran between two coarse bins and pointed wherever
    that happened to face — 110 degrees for DAM-SHJ, while the aircraft was tracking 304.
    """
    import math
    from main import anchored
    learned = [{"f": 0.0125, "lat": 33.2, "lon": 36.8}, {"f": 0.9875, "lat": 25.57, "lon": 55.26}]
    out = anchored(learned, DAM, SHJ)
    a, b = out[-2], out[-1]
    r = math.pi / 180
    dLon = (b["lon"] - a["lon"]) * r
    y = math.sin(dLon) * math.cos(b["lat"] * r)
    x = (math.cos(a["lat"] * r) * math.sin(b["lat"] * r)
         - math.sin(a["lat"] * r) * math.cos(b["lat"] * r) * math.cos(dLon))
    brg = (math.atan2(y, x) / r + 360) % 360
    # South-east, from the last bin down onto Sharjah.
    assert 100 < brg < 140, f"expected the final leg to point at SHJ, got {brg:.0f}"


def test_a_missing_airport_leaves_that_end_alone():
    # No coordinates means no anchor. Better a corridor that stops short than one that runs to 0,0.
    learned = [{"f": 0.0125, "lat": 33.2, "lon": 36.8}, {"f": 0.9875, "lat": 25.57, "lon": 55.26}]
    out = _anchored(learned, None, SHJ)
    assert out[0]["f"] == 0.0125
    assert out[-1]["f"] == 1.0


def test_an_empty_path_stays_empty():
    assert _anchored([], DAM, SHJ) == []


def test_the_corridor_hands_back_to_the_fix_near_the_destination():
    """
    ABY352 into Sharjah, 27 Aug, watched live. It crossed abeam the field, ran 20 km downwind,
    turned and came back — because it arrives from the north-west and runway 30 is approached from
    the south-east. gc_fraction saturated at 1.0 the moment it drew level, so the marker sat on the
    airport for five minutes while the aeroplane was 20 km away, then froze when the ETA passed.

    A corridor is a line from A to B; a circuit is not expressible on one. Inside TERMINAL_KM the
    fix is both denser and exact, so the corridor gives way.
    """
    from main import draws_on_corridor
    near = {"lat": 25.40, "lon": 55.40, "on_ground": False}    # ~13 km from SHJ
    far  = {"lat": 27.50, "lon": 53.00, "on_ground": False}    # ~350 km out
    assert draws_on_corridor("learned", far, SHJ) is True
    assert draws_on_corridor("learned", near, SHJ) is False


def test_without_a_destination_the_handback_cannot_fire():
    # No arrival coordinates means no distance to test. The corridor keeps its other guards
    # rather than being switched off on a measurement nobody could take.
    from main import draws_on_corridor
    airborne = {"lat": 25.40, "lon": 55.40, "on_ground": False}
    assert draws_on_corridor("learned", airborne, None) is True


def test_the_handback_boundary_is_the_named_constant():
    # Guards against the threshold drifting away from what the comment claims.
    import math
    from main import draws_on_corridor, TERMINAL_KM
    # A degree of latitude is ~111 km, so this sits just outside the ring due north of SHJ.
    outside = {"lat": SHJ[0] + (TERMINAL_KM + 10) / 111.0, "lon": SHJ[1], "on_ground": False}
    inside  = {"lat": SHJ[0] + (TERMINAL_KM - 10) / 111.0, "lon": SHJ[1], "on_ground": False}
    assert draws_on_corridor("learned", outside, SHJ) is True
    assert draws_on_corridor("learned", inside, SHJ) is False

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

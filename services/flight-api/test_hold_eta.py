"""
The ETA damping, tested against the tape that motivated it.

Run:  python3 -m pytest services/flight-api/test_hold_eta.py -q
  or: python3 services/flight-api/test_hold_eta.py

hold_eta is pure — state is passed in — so this needs no database, no network and no app.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# main.py reads its configuration at import and fails fast without it, which is right for a
# service and inconvenient for a unit test. Placeholders rather than making the module lenient:
# nothing here opens a connection, and a service that starts up misconfigured is worse.
os.environ.setdefault("SUPABASE_URL", "https://example.invalid")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
os.environ.setdefault("SUPABASE_ANON_KEY", "test")

from main import hold_eta, ETA_WOBBLE_MIN  # noqa: E402

KEY = ("2026-08-12", "RB515", "DAM", "SHJ")

# RB515 on 12 Aug, verbatim: two values, five reversals, forty minutes. Nobody chose either of
# them twice — FR24 simply alternated, and both clients moved the countdown with it.
A = "2026-08-12T13:22:08+00:00"
B = "2026-08-12T13:24:16+00:00"
RB515_TAPE = [A, B, A, B, A, B]


def test_wobble_never_reaches_the_screen():
    held: dict = {}
    shown = [hold_eta(KEY, v, held) for v in RB515_TAPE]
    assert shown == [A] * 6, f"the countdown moved on a bounce: {shown}"


def test_a_real_revision_is_adopted():
    held: dict = {}
    hold_eta(KEY, A, held)
    # Twenty minutes later is a delay, not noise, and a reader must see it.
    late = "2026-08-12T13:42:08+00:00"
    assert hold_eta(KEY, late, held) == late


def test_the_threshold_is_where_it_says_it_is():
    held: dict = {}
    hold_eta(KEY, "2026-08-12T13:00:00+00:00", held)
    # A minute under holds; the threshold itself is adopted. Stated because "about three
    # minutes" is the kind of boundary that drifts silently.
    assert hold_eta(KEY, "2026-08-12T13:02:00+00:00", held) == "2026-08-12T13:00:00+00:00"
    on_the_nose = f"2026-08-12T13:0{ETA_WOBBLE_MIN}:00+00:00"
    assert hold_eta(KEY, on_the_nose, held) == on_the_nose


def test_moving_back_counts_too():
    held: dict = {}
    hold_eta(KEY, "2026-08-12T13:30:00+00:00", held)
    # Arriving earlier than expected is as real as arriving later; the guard is on distance,
    # not direction.
    early = "2026-08-12T13:20:00+00:00"
    assert hold_eta(KEY, early, held) == early


def test_no_estimate_clears_the_hold():
    held: dict = {}
    hold_eta(KEY, A, held)
    assert hold_eta(KEY, None, held) is None
    assert KEY not in held, "a stale anchor would resurface if the estimate came back"


def test_flights_do_not_share_an_anchor():
    held: dict = {}
    other = ("2026-08-12", "RB516", "DAM", "SHJ")
    hold_eta(KEY, A, held)
    assert hold_eta(other, "2026-08-12T19:00:00+00:00", held) == "2026-08-12T19:00:00+00:00"
    assert hold_eta(KEY, B, held) == A, "one flight's revision must not move another's"


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

"""
One aircraft, one position, one instant.

Run:  python3 services/flight-api/test_sample_dedupe.py

Exercises learn.record's dedupe without a network: the POST is captured rather than sent, so what
is asserted is exactly the payload that would have gone to the table.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import learn

APS = {"DAM": (33.41, 36.52), "KWI": (29.23, 47.97), "ALP": (36.18, 37.22)}
FIX = {"pos_source": "observed", "lat": 32.0, "lon": 37.0, "on_ground": False,
       "fix_at": "2026-08-17T13:34:20.052774+00:00", "altitude_ft": 16000,
       "ground_speed_kts": 349, "track_deg": 41, "source": "adsb"}


def leg(flight_date: str, **kw) -> dict:
    base = {"callsign": "RJA437", "iata_number": "RJ437", "dep_iata": "AMM", "arr_iata": "DAM",
            "flight_date": flight_date, "position": dict(FIX)}
    base.update(kw)
    return base


class Captured:
    """Stands in for the HTTP client; keeps the payload instead of sending it."""
    def __init__(self):
        self.payloads = []

    async def post(self, url, headers=None, json=None, timeout=None):
        self.payloads.append(json)
        class R:
            status_code = 201
        return R()


def sent(flights) -> list[dict]:
    c = Captured()
    asyncio.run(learn.record(c, "http://sb", {}, flights, {**APS, "AMM": (31.72, 35.99)}))
    return c.payloads[0] if c.payloads else []


def test_two_board_rows_for_one_aeroplane_write_one_sample():
    """
    The unique index is (callsign, flight_date, seen_at), so the date is part of the key and two
    rows for the same aircraft defeat it: both are handed the SAME fix, because position is looked
    up by callsign, and each writes it under its own date.

    RJA437 did this on 17 Aug while its identity flipped from the 16th to the 17th mid-flight.
    """
    rows = sent([leg("2026-08-16"), leg("2026-08-17")])
    assert len(rows) == 1, f"one aeroplane, one sample, got {len(rows)}"


def test_the_surviving_sample_is_intact():
    rows = sent([leg("2026-08-16"), leg("2026-08-17")])
    r = rows[0]
    assert r["callsign"] == "RJA437"
    assert r["seen_at"] == FIX["fix_at"]
    assert r["alt_ft"] == 16000 and r["gs_kts"] == 349


def test_the_pairing_is_ordinary_not_exotic():
    """
    Twelve callsigns were carrying two open rows when this was written — today's leg and
    tomorrow's, the same number on consecutive days. This is not a rare race.
    """
    rows = sent([leg("2026-08-17"), leg("2026-08-18")])
    assert len(rows) == 1


def test_different_aircraft_at_the_same_instant_are_both_kept():
    # The dedupe is per aircraft. Two aeroplanes sharing a timestamp is normal.
    rows = sent([leg("2026-08-17"), leg("2026-08-17", callsign="FYC702",
                                        dep_iata="KWI", arr_iata="DAM")])
    assert len(rows) == 2


def test_the_same_aircraft_at_two_instants_is_two_samples():
    # Deduping on the callsign alone would throw away the track.
    later = leg("2026-08-17")
    later["position"] = dict(FIX, fix_at="2026-08-17T13:36:31.543192+00:00", lat=32.34)
    rows = sent([leg("2026-08-17"), later])
    assert len(rows) == 2


def test_a_projected_position_is_never_sampled():
    # Unchanged by the dedupe, and the reason it matters: a corridor learned from its own
    # projection would confirm whatever it already believed.
    projected = leg("2026-08-17")
    projected["position"] = dict(FIX, pos_source="projected")
    assert sent([projected]) == []


def test_a_taxiing_aircraft_is_not_a_route():
    grounded = leg("2026-08-17")
    grounded["position"] = dict(FIX, on_ground=True)
    assert sent([grounded]) == []


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

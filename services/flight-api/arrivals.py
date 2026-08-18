"""
One flight, asked about directly.

THE PROBLEM THIS SOLVES. We cannot see our flights land abroad. Measured 17 Aug against the
Arabia circle, which is the one Kuwait falls inside (132 nm of its 250 nm radius): 36 aircraft in
the entire circle, NONE within 60 nm of Kuwait, and the lowest altitude anywhere in it was
1,025 ft. Being inside a circle geometrically is not coverage — it needs a feeder on the ground,
and around the Gulf outstations there is not one. So an aircraft on approach to KWI simply stops
existing, and arrival becomes a guess.

FR24 will answer for a single flight number. `flight/list.json?fetchBy=flight` returns that
flight's legs — future schedule and past history in one list — each with `time.real.arrival`, the
actual touchdown. Verified 17 Aug:

    FYC701  DAM->KWI   sched 09:30Z   real 09:05Z   "Landed 12:05"   25 min early

THIS IS THE PER-FLIGHT ENDPOINT, DELIBERATELY, NOT THE AIRPORT BOARD. The airport board answers
the same question and costs 20-60x as much: 174 KB at Kuwait, 839 KB at Istanbul, needing a
learned per-airport row density and pagination to cover a useful window, all to extract the one
row we care about. This is 8-26 KB and needs none of it.

IT IS THE UNDOCUMENTED WIDGET, NOT THE PAID API. It can change or start refusing us without
notice. Every caller must treat a missing answer as "no information", never as "did not land" —
which is why arrival_of returns None rather than a negative, and why nothing here ever writes a
phase backwards.
"""

from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timezone

FETCH_TIMEOUT_S = 30.0
CACHE_TTL_S = 300.0

# Enough rows to reach past the future-scheduled block into the recent past.
#
# The list arrives newest-first and a daily service has a week of scheduled legs sitting on the
# front of it: FYC701 returned 7 future rows before today's, and limit=5 saw nothing but
# schedule. 25 rows reached 11 Aug and cost 26 KB.
DEFAULT_LIMIT = 25

# How far a leg's scheduled arrival may sit from the one we are asking about and still be it.
# Wide enough for a badly delayed leg, narrow enough that yesterday's cannot be mistaken for
# today's on a daily route.
LEG_TOLERANCE_MS = 8 * 3600_000

# When a flight is worth asking about, relative to its expected arrival.
#
# Early enough to catch one that lands ahead of schedule — FYC701 was on the ground 25 minutes
# early — and long enough afterwards to cover a late publication, then give up rather than ask
# for ever. A confirmed flight stops being asked about immediately, so the tail only costs
# anything for the legs FR24 has not published.
POLL_FROM_MS = 20 * 60_000
POLL_UNTIL_MS = 2 * 3600_000

_cache: dict[str, tuple[float, list[dict]]] = {}
_state: dict = {"last_lookup_at": None, "fetches": 0, "failures": 0, "matched": 0}


def awaiting_arrival(flight: dict, now_ms: float) -> bool:
    """
    Is this a flight we are still waiting on, near enough its arrival to ask?

    Departed, not already closed, and inside the window. Everything else is either not yet a
    question or no longer one.
    """
    if flight.get("real_arr") or flight.get("arr_confirmed_at"):
        return False

    # A recorded departure is deliberately NOT required.
    #
    # It was, and that was backwards. Of 35 unconfirmed legs in a fortnight, 32 have no real_dep
    # at all — a flight we never saw leave is the one we know LEAST about, and gating on the
    # departure skipped 91% of the very rows this exists to close. FR24 frequently holds both
    # ends of a leg we recorded neither of.
    #
    # Nothing is lost by asking: confirm_arrival matches on date and route and accepts only an
    # explicit landing, so a flight that never operated simply returns None.
    eta = flight.get("est_arr_ms") or flight.get("sched_arr_ms")
    if not eta:
        return False
    return eta - POLL_FROM_MS <= now_ms <= eta + POLL_UNTIL_MS


def state() -> dict:
    return dict(_state)


# ── Identity ──────────────────────────────────────────────────────────────────

def normalise_number(n: str | None) -> str | None:
    """
    A flight number in the one form two sources can be compared in.

    FR24 pads and spaces inconsistently — "RB 0441", "RB0441" and "RB441" are the same flight —
    and an exact string compare drops real arrivals silently, the worst possible failure for
    something whose only job is to confirm a landing.
    """
    if not n:
        return None
    s = re.sub(r"[^A-Z0-9]", "", str(n).upper())
    m = re.match(r"^([A-Z]+)0*(\d+)$", s)
    return f"{m.group(1)}{int(m.group(2))}" if m else (s or None)


def query_forms(flight: dict) -> list[str]:
    """
    Every string worth asking FR24 about for this flight, best guess first.

    BOTH forms have to be tried, because which one FR24 indexes is decided per airline and there
    is no rule to predict it. Measured 17 Aug, all four with HTTP 200:

        FYC701 -> 14 rows        XH701  -> 0 rows      (Fly Cham answers to ICAO)
        RB441  ->  1 row         SYR441 -> 0 rows      (Syrian Air answers to IATA)

    Picking either one alone would silently return nothing for half the fleet — and "nothing"
    from this source is indistinguishable from "has not landed yet".
    """
    forms, seen = [], set()
    for raw in (flight.get("callsign"), flight.get("iata_number")):
        n = normalise_number(raw)
        if n and n not in seen:
            seen.add(n)
            forms.append(n)
    return forms


def flight_url(number: str, limit: int = DEFAULT_LIMIT) -> str:
    return ("https://api.flightradar24.com/common/v1/flight/list.json"
            f"?query={number}&fetchBy=flight&page=1&limit={limit}")


# ── Reading the answer ────────────────────────────────────────────────────────

def parse_legs(payload: dict) -> list[dict]:
    """This flight's legs, flattened. Never raises on a shape change."""
    try:
        rows = payload["result"]["response"]["data"] or []
    except (KeyError, TypeError):
        return []

    out = []
    for f in rows or []:
        ident = (f or {}).get("identification") or {}
        ap = (f or {}).get("airport") or {}
        t = (f or {}).get("time") or {}
        out.append({
            "number":   ((ident.get("number") or {}).get("default")),
            "dep_iata": (((ap.get("origin") or {}).get("code") or {}).get("iata")),
            "arr_iata": (((ap.get("destination") or {}).get("code") or {}).get("iata")),
            "sched_arrival": ((t.get("scheduled") or {}).get("arrival")),
            "real_arrival":  ((t.get("real") or {}).get("arrival")),
            "real_departure": ((t.get("real") or {}).get("departure")),
            "status": ((f or {}).get("status") or {}).get("text"),
        })
    return out


def pick_leg(legs: list[dict], dep_iata: str | None, arr_iata: str | None,
             sched_arr_ms: float) -> dict | None:
    """
    The one leg that is the flight we asked about.

    The list holds every date this number flies — a week of future schedule and a fortnight of
    history — so the date has to be pinned or we would happily report last Tuesday's landing as
    today's. Route is checked too: a number can be reused on a different pairing.
    """
    best, best_gap = None, None
    for leg in legs:
        if dep_iata and leg.get("dep_iata") and leg["dep_iata"].upper() != dep_iata.upper():
            continue
        if arr_iata and leg.get("arr_iata") and leg["arr_iata"].upper() != arr_iata.upper():
            continue
        sa = leg.get("sched_arrival")
        if not sa:
            continue
        gap = abs(sa * 1000 - sched_arr_ms)
        if gap <= LEG_TOLERANCE_MS and (best_gap is None or gap < best_gap):
            best, best_gap = leg, gap
    return best


_LANDED_AT = re.compile(r"^\s*Landed\s+(\d{1,2}):(\d{2})\s*$", re.I)


def status_arrival(leg: dict, utc_offset_h: float | None) -> int | None:
    """
    The touchdown as written in the status TEXT, in unix seconds.

    FR24 does not always fill time.real.arrival, and at the Syrian airports it usually does not —
    but the status still says so in words. Measured 17 Aug over a week of TK844 into Aleppo:

        16 Aug   real 06:38Z   "Landed 09:38"     both
        12 Aug   real  —       "Landed 09:35"     text only
        11 Aug   real  —       "Landed 09:32"     text only

    Reading only the numeric field scored 0 of 45 on exactly the legs we most need. That is not
    FR24 being blind over Syria — it is us not reading the answer.

    The text is LOCAL time at the arrival airport and carries no date, so it is placed on the day
    of the scheduled arrival and then pulled to whichever adjacent day it sits closest to. That
    wrap is not decoration: a flight scheduled 23:50 and landing 00:15 belongs to the next day,
    and without it every midnight arrival would be recorded 24 hours out.
    """
    m = _LANDED_AT.match(leg.get("status") or "")
    sched = leg.get("sched_arrival")
    if not m or not sched or utc_offset_h is None:
        return None
    hh, mm = int(m.group(1)), int(m.group(2))
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return None

    offset = int(utc_offset_h * 3600)
    local_day = (sched + offset) // 86400 * 86400          # midnight of the scheduled local day
    candidate = local_day + hh * 3600 + mm * 60 - offset
    best = min((candidate + d * 86400 for d in (-1, 0, 1)), key=lambda t: abs(t - sched))

    # An aeroplane cannot land before it takes off.
    #
    # The text is dated to the day the flight ACTUALLY arrived, and we can only anchor it on the
    # day it was SCHEDULED to. A leg that runs a day late therefore lands on the wrong day:
    # RB272 into Amsterdam, scheduled 10 Aug, resolved exactly 1,441 minutes early — the only
    # failure in 41 legs that carried both forms. There is no way to detect that from the text
    # alone, but the departure gives it away, and declining is the contract here. A wrong arrival
    # time is far worse than an absent one.
    dep = leg.get("real_departure")
    if dep and best <= dep:
        return None
    return best


def arrival_of(leg: dict | None, utc_offset_h: float | None = None) -> dict | None:
    """
    A confirmed touchdown, or None.

    None means "FR24 does not tell us", NOT "it has not landed". The distinction is the whole
    contract: a caller reading None as a negative would un-land flights every time FR24 publishes
    late, and the marker would resurrect.
    """
    if not leg:
        return None
    real, precise = leg.get("real_arrival"), True
    if not real:
        real, precise = status_arrival(leg, utc_offset_h), False
    if not real:
        return None                                  # scheduled or estimated: not evidence
    return {
        "arrived_at": datetime.fromtimestamp(real, timezone.utc).isoformat(),
        "arrived_at_ms": real * 1000,
        "source": "fr24_flight" if precise else "fr24_flight_status",
        # A minute-resolution time read out of prose, versus a timestamp. Same event, different
        # confidence, and a caller weighing this against ADS-B needs to know which it has.
        "precise": precise,
        "status_text": leg.get("status"),
    }


# ── I/O ───────────────────────────────────────────────────────────────────────

def _fetch_sync(url: str) -> dict | None:
    from curl_cffi import requests as cr           # imported here so the module loads without it
    r = cr.get(url, impersonate="chrome", timeout=FETCH_TIMEOUT_S)
    return r.json() if r.status_code == 200 else None


async def legs_for(number: str, now: float | None = None) -> list[dict]:
    """Every leg FR24 holds for this flight number, cached. [] when we could not read it."""
    now = time.time() if now is None else now
    hit = _cache.get(number)
    if hit and now - hit[0] < CACHE_TTL_S:
        return hit[1]
    try:
        payload = await asyncio.to_thread(_fetch_sync, flight_url(number))
        _state["fetches"] += 1
    except Exception:
        _state["failures"] += 1
        return hit[1] if hit else []                # stale beats blind
    if payload is None:
        _state["failures"] += 1
        return hit[1] if hit else []
    legs = parse_legs(payload)
    _cache[number] = (now, legs)
    return legs


async def confirm_arrival(flight: dict, utc_offset_h: float | None = None) -> dict | None:
    """
    Has this flight landed? The whole question, for one flight.

    Tries each identity form until one answers with legs, then pins the right date. Returns None
    for "we do not know", never for "no".

    `utc_offset_h` is the arrival airport's offset, needed only to read a time out of the status
    text. Without it that fallback is skipped and the numeric field is all we can use — which on
    Syrian arrivals means almost nothing.
    """
    sched_arr_ms = flight.get("est_arr_ms") or flight.get("sched_arr_ms")
    if not sched_arr_ms:
        return None
    for number in query_forms(flight):
        legs = await legs_for(number)
        if not legs:
            continue                                 # this form is not the one FR24 indexes
        hit = arrival_of(pick_leg(legs, flight.get("dep_iata"),
                                  flight.get("arr_iata"), sched_arr_ms), utc_offset_h)
        _state["last_lookup_at"] = datetime.now(timezone.utc).isoformat()
        if hit:
            _state["matched"] += 1
            return hit
    return None

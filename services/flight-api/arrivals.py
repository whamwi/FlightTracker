"""
Arrival truth from the destination airport's own board.

THE PROBLEM THIS SOLVES. We cannot see our flights land abroad. Measured 17 Aug against the
Arabia circle, which is the one Kuwait falls inside (132 nm from its centre, well within the 250
nm radius): 36 aircraft in the entire circle, NONE within 60 nm of Kuwait, and the lowest altitude
anywhere in it was 1,025 ft. Being inside a circle geometrically is not coverage — it needs a
feeder on the ground, and around the Gulf outstations there is not one. So an aircraft on approach
to KWI simply stops existing, and the service is left guessing when it landed.

The destination airport knows. FR24's widget endpoint is keyed BY AIRPORT rather than by flight,
and every row carries `time.real.arrival` — the actual touchdown, not an estimate. Verified 17 Aug
on the flight that prompted this:

    FYC701  DAM->KWI   sched 1786959000   real 1786957508   "Landed 12:05"   25 min early

That is the same number the website's /fr24 page shows, and it is available for every outstation
on the network — the half of each flight the Syrian boards cannot see.

WHY THIS CAN RUN ON THE SERVER, WHEN THE WEBSITE'S VERSION CANNOT. The /fr24 page says plainly
that it must run in a browser: "Cloudflare answers a Vercel function with a challenge page
regardless of headers". True — of a Node function on Vercel. This service is Python on Railway,
and curl_cffi's TLS impersonation clears the same challenge, which is what scripts/fr24_harvest.py
already relies on. Verified from this machine: HTTP 200, 100 arrivals, 519 KB.

IT IS THE UNDOCUMENTED WIDGET, NOT THE PAID API. It can change or start refusing us without
notice. Every caller must treat a missing answer as "no information", never as "did not land" —
which is why match_arrival returns None rather than a negative, and why nothing here ever writes
a phase backwards.
"""

from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timezone

# This stops two flights into the same airport costing two fetches, and keeps a flight that is
# late confirming from re-fetching the same board every pass.
CACHE_TTL_S = 300.0

FETCH_TIMEOUT_S = 30.0
POLL_PAUSE_S = 120.0

# How many rows to ask for, and why it cannot be a constant.
#
# A row count buys wildly different amounts of TIME depending on how busy the airport is.
# Measured 17 Aug:
#
#     KWI  limit= 20   174 KB    4.3 h of board
#     DXB  limit= 20   207 KB    1.4 h
#     IST  limit= 20   233 KB    0.3 h
#     IST  limit=100   839 KB    2.2 h
#
# and 100 is the ceiling — limit=200 is answered with HTTP 400. So a fixed limit either wastes a
# megabyte at Kuwait or covers twenty minutes at Istanbul. Each airport's density is learned from
# what it actually returned, and the limit follows it.
MIN_LIMIT, MAX_LIMIT = 20, 100
ASSUMED_ROWS_PER_HOUR = 30.0      # until an airport has answered once

_density: dict[str, float] = {}   # airport -> rows per hour, learned

# When an airport becomes worth asking about, relative to a flight's expected arrival there.
#
# Early enough to catch a flight that lands ahead of schedule — FYC701 was on the ground 25
# minutes early — and long enough afterwards to cover a late publication, then give up rather
# than poll forever. A confirmed flight drops out immediately (see airports_due), so the tail
# only costs anything for flights FR24 has not published yet.
POLL_FROM_MS = 20 * 60_000        # twenty minutes before expected arrival
POLL_UNTIL_MS = 2 * 3600_000      # two hours after, then stop asking

_cache: dict[str, tuple[float, list[dict]]] = {}
_state: dict = {"last_poll_at": None, "airports": 0, "fetches": 0, "failures": 0, "matched": 0}


def state() -> dict:
    return dict(_state)


# ── Identity ──────────────────────────────────────────────────────────────────

def normalise_number(n: str | None) -> str | None:
    """
    A flight number in the one form two sources can be compared in.

    FR24 pads and spaces inconsistently — "RB 0441", "RB0441" and "RB441" are the same flight —
    so an exact string match drops real arrivals silently, which is the worst possible failure
    for something whose whole job is to confirm a landing.
    """
    if not n:
        return None
    s = re.sub(r"[^A-Z0-9]", "", str(n).upper())
    m = re.match(r"^([A-Z]+)0*(\d+)$", s)
    return f"{m.group(1)}{int(m.group(2))}" if m else (s or None)


def flight_identities(flight: dict) -> set[str]:
    """
    Every string this flight might be called on someone else's board.

    Each flight has two identifiers and assuming one has broken this project three separate times
    in a day: RB441 is SYR441 on the wire, XH701 is FYC701. FR24's `number.default` is sometimes
    the IATA form and sometimes the ICAO one — the KWI board showed FYC701, not XH701 — so
    matching on iata_number alone would have missed the very flight that proved this works.
    """
    out = {normalise_number(flight.get("iata_number")), normalise_number(flight.get("callsign"))}
    return {x for x in out if x}


# ── What to ask, and when ─────────────────────────────────────────────────────

def airports_due(flights: list[dict], now_ms: float) -> dict[str, float]:
    """
    Airports worth asking about right now, mapped to the earliest arrival we are waiting on.

    Demand-driven on purpose. There are 29 airports in route_master and polling all of them on a
    timer would be ~29 MB a pass to learn nothing about the 25 with no flight due. Asking only
    where we are actually expecting someone keeps a pass to a handful of fetches.
    """
    due: dict[str, float] = {}
    for f in flights:
        code = (f.get("arr_iata") or "").strip().upper()
        if not code or f.get("arrived_at"):        # already confirmed; nothing left to learn
            continue
        eta = f.get("est_arr_ms") or f.get("sched_arr_ms")
        if not eta:
            continue
        if eta - POLL_FROM_MS <= now_ms <= eta + POLL_UNTIL_MS:
            due[code] = min(due.get(code, eta), eta)
    return due


# The board is read as a rolling window over the recent past, anchored on NOW rather than on any
# one flight's arrival time.
#
# Anchoring on the flight was the obvious design and it does not survive contact with Istanbul: a
# hundred rows there span 2.2 h, so a window opened two hours before the ETA runs out before the
# aeroplane lands, and the arrival is never in the answer at all. Anchored on now, the board
# always covers what has just landed — which is the only thing we are asking it — and because the
# poller comes back every couple of minutes, a touchdown only has to appear once.
LOOKBACK_MS = 90 * 60_000
COVER_HOURS = LOOKBACK_MS / 3600_000 + 0.25      # the lookback, plus margin for a thin board


def limit_for(code: str) -> int:
    """Enough rows to span the lookback at this airport's observed density."""
    density = _density.get(code, ASSUMED_ROWS_PER_HOUR)
    return max(MIN_LIMIT, min(MAX_LIMIT, int(COVER_HOURS * density * 1.25) + 1))


def widget_url(code: str, now_ms: float, limit: int | None = None) -> str:
    """
    The airport board, as a window over the last hour and a half.

    The timestamp anchors where the returned list STARTS. The page that inspired this uses local
    midnight — fine for Deir ez-Zor, useless at Dubai, where the rows run out long before an
    evening arrival.
    """
    ts = int((now_ms - LOOKBACK_MS) / 1000)
    lim = limit_for(code) if limit is None else limit
    return ("https://api.flightradar24.com/common/v1/airport.json"
            f"?code={code}&plugin=&plugin-setting[schedule][mode]="
            f"&plugin-setting[schedule][timestamp]={ts}&page=1&limit={lim}&fleet=&token=")


def note_density(code: str, rows: list[dict]) -> None:
    """
    Learn how much time this airport's rows are worth, so the next request asks for the right
    number of them. Needs two timestamps to measure a span at all.
    """
    ts = sorted(r["sched_arrival"] for r in rows if r.get("sched_arrival"))
    if len(ts) < 2:
        return
    hours = (ts[-1] - ts[0]) / 3600.0
    if hours > 0.05:
        _density[code] = len(ts) / hours


# ── Reading the answer ────────────────────────────────────────────────────────

def parse_arrivals(payload: dict) -> list[dict]:
    """The arrivals list, flattened to the four fields that matter. Never raises on a shape change."""
    try:
        rows = (payload["result"]["response"]["airport"]["pluginData"]
                ["schedule"]["arrivals"]["data"]) or []
    except (KeyError, TypeError):
        return []

    out = []
    for r in rows:
        fl = (r or {}).get("flight") or {}
        ident = fl.get("identification") or {}
        t = fl.get("time") or {}
        out.append({
            "number":   ((ident.get("number") or {}).get("default")),
            "callsign": ident.get("callsign"),
            "origin":   (((fl.get("airport") or {}).get("origin") or {})
                         .get("code") or {}).get("iata"),
            "real_arrival":  ((t.get("real") or {}).get("arrival")),
            "sched_arrival": ((t.get("scheduled") or {}).get("arrival")),
            "status": ((fl.get("status") or {}).get("text")),
        })
    return out


def match_arrival(flight: dict, rows: list[dict]) -> dict | None:
    """
    This flight's confirmed touchdown on that board, or None.

    None means "the board does not tell us", NOT "it has not landed". The distinction is the whole
    contract: a caller that reads None as a negative would un-land flights every time FR24 is
    slow to publish, and the marker would resurrect.

    The origin is checked as well as the number because a flight number is only unique per day
    per airline — and on a board that spans a day boundary yesterday's leg is sitting right there.
    """
    ids = flight_identities(flight)
    if not ids:
        return None
    dep = (flight.get("dep_iata") or "").strip().upper()

    for r in rows:
        if not r.get("real_arrival"):
            continue                                    # scheduled or estimated: not evidence
        if not ({normalise_number(r.get("number")), normalise_number(r.get("callsign"))} & ids):
            continue
        if dep and r.get("origin") and r["origin"].strip().upper() != dep:
            continue                                    # same number, different leg
        return {
            "arrived_at": datetime.fromtimestamp(r["real_arrival"], timezone.utc).isoformat(),
            "arrived_at_ms": r["real_arrival"] * 1000,
            "source": "fr24_widget",
            "status_text": r.get("status"),
        }
    return None


# ── I/O ───────────────────────────────────────────────────────────────────────

def _fetch_sync(url: str) -> dict | None:
    from curl_cffi import requests as cr           # imported here so the module loads without it
    r = cr.get(url, impersonate="chrome", timeout=FETCH_TIMEOUT_S)
    return r.json() if r.status_code == 200 else None


async def board(code: str, now_ms: float, now: float | None = None) -> list[dict]:
    """One airport's arrivals, cached. Returns [] when we could not read it — never raises."""
    now = time.time() if now is None else now
    hit = _cache.get(code)
    if hit and now - hit[0] < CACHE_TTL_S:
        return hit[1]
    try:
        payload = await asyncio.to_thread(_fetch_sync, widget_url(code, now_ms))
        _state["fetches"] += 1
    except Exception:
        _state["failures"] += 1
        return hit[1] if hit else []                # stale beats blind
    if payload is None:
        _state["failures"] += 1
        return hit[1] if hit else []
    rows = parse_arrivals(payload)
    note_density(code, rows)
    _cache[code] = (now, rows)
    return rows


async def confirm(flights: list[dict], now_ms: float) -> dict[str, dict]:
    """
    Ask each due airport once, and return the confirmed arrivals keyed by callsign.

    Sequential rather than concurrent: this is a Cloudflare-gated endpoint we are not entitled to
    hammer, the volume is a handful of airports, and nothing downstream is waiting on the answer.
    """
    due = airports_due(flights, now_ms)
    _state["airports"] = len(due)
    boards = {code: await board(code, now_ms) for code in due}

    found: dict[str, dict] = {}
    for f in flights:
        code = (f.get("arr_iata") or "").strip().upper()
        rows = boards.get(code)
        if not rows:
            continue
        hit = match_arrival(f, rows)
        if hit:
            cs = (f.get("callsign") or f.get("iata_number") or "").strip().upper()
            if cs:
                found[cs] = hit
    _state.update(matched=len(found),
                  last_poll_at=datetime.now(timezone.utc).isoformat())
    return found

#!/usr/bin/env python3
"""
Server-side FR24 airport harvest — prototype, read-only.

What this is
------------
The board currently gets its schedule data by making the *visitor's browser* call
api.flightradar24.com/common/v1/airport.json and POST the result back to /api/fr24-cache.
That works because a browser passes FR24's bot check; a plain HTTP client gets 403.

curl_cffi impersonates a browser's TLS fingerprint, which clears the same check from a server.
This script proves the acquisition half end to end: fetch, normalise to exactly the row shape
/api/fr24-cache already expects, and report what came back.

What this deliberately is NOT
-----------------------------
It writes nothing. No Supabase, no /api/fr24-cache, no change to either app. Output goes to
stdout and, with --out, to a JSON file. Wiring it up is a separate decision.

The normalisation is a line-by-line port of normFlight() in app/board/page.tsx, including the
odd bits — the registration fallback for YK-BAA, the 300-minute sanity cap, bucketing by the
Damascus-local date of the scheduled time rather than the requested date. Same rules in, same
rows out, so any difference against the live cache is a real difference and not a porting bug.

Usage
-----
    pip install curl_cffi
    python3 fr24_harvest.py --airports DAM,ALP,DEZ
    python3 fr24_harvest.py --airports DXB,IST,AMM --out dest.json
    python3 fr24_harvest.py --airports DAM --date 2026-08-11
    python3 fr24_harvest.py --airports DAM,ALP --earlier      # includes yesterday's stragglers
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any

try:
    from curl_cffi import requests as cr
except ImportError:
    sys.exit("curl_cffi is required:  pip install curl_cffi")

# Damascus is UTC+3 year round — the same assumption syriaDate() makes in both apps.
TZ = timezone(timedelta(hours=3))

BASE = "https://api.flightradar24.com/common/v1/airport.json"

# The browser sends no token and gets full data, so the endpoint does not gate this on auth.
# Its check is on the client fingerprint, which is what impersonate= answers.
IMPERSONATE = "chrome"

# A flight whose number FR24 omits, recovered from its registration. Carried over from the
# browser path rather than dropped: without it this aircraft arrives with no flight number.
REG_TO_FLIGHT = {"YK-BAA": "FYC728"}

# Anything longer is FR24 pairing the wrong legs — a 20-hour "flight" between two Syrian
# airports is the failure this catches. Same cap as the browser path.
MAX_DURATION_MIN = 300

# Used only by --only-syria, to keep a hub's own traffic out of the output.
SYRIA = {"DAM", "ALP", "DEZ", "LTK"}

# Politeness, and self-preservation: see the 429 note in fetch_page.
RETRIES = 3
BACKOFF_SEC = 5
DELAY_SEC = 1.0


def local_date(unix: int) -> str:
    """The Damascus-local calendar date of a unix timestamp, as YYYY-MM-DD."""
    return datetime.fromtimestamp(unix, TZ).strftime("%Y-%m-%d")


def norm_flight(entry: dict[str, Any]) -> dict[str, Any] | None:
    """One FR24 schedule entry as a cache row, or None if it is unusable."""
    fl = entry.get("flight")
    if not fl:
        return None

    ident = fl.get("identification") or {}
    time_ = fl.get("time") or {}
    ap = fl.get("airport") or {}
    origin = ap.get("origin") or {}
    dest = ap.get("destination") or {}

    reg = ((fl.get("aircraft") or {}).get("registration"))
    num = (
        ((ident.get("number") or {}).get("default"))
        or ident.get("callsign")
        or (REG_TO_FLIGHT.get(reg) if reg else None)
        or reg
    )

    sched = time_.get("scheduled") or {}
    sched_dep, sched_arr = sched.get("departure"), sched.get("arrival")
    # A row without both ends cannot be placed on a board or a map.
    if not sched_dep or not sched_arr:
        return None

    duration_min = round((sched_arr - sched_dep) / 60)
    if duration_min > MAX_DURATION_MIN:
        return None

    est = time_.get("estimated") or {}
    real = time_.get("real") or {}
    o_info = origin.get("info") or {}
    d_info = dest.get("info") or {}

    return {
        "num": num,
        "fr24_id": ident.get("id"),
        "airline": (fl.get("airline") or {}).get("name"),
        "airline_iata": ((fl.get("airline") or {}).get("code") or {}).get("iata"),
        "dep_iata": ((origin.get("code") or {}).get("iata")),
        "arr_iata": ((dest.get("code") or {}).get("iata")),
        "sched_dep": sched_dep,
        "sched_arr": sched_arr,
        "duration_min": duration_min,
        "status": (fl.get("status") or {}).get("text"),
        "est_dep": est.get("departure"),
        "est_arr": est.get("arrival"),
        "real_dep": real.get("departure"),
        "real_arr": real.get("arrival"),
        "aircraft": ((fl.get("aircraft") or {}).get("model") or {}).get("code"),
        "reg": reg,
        "dep_terminal": o_info.get("terminal"),
        "dep_gate": o_info.get("gate"),
        "arr_terminal": d_info.get("terminal"),
        "arr_gate": d_info.get("gate"),
        "arr_baggage": d_info.get("baggage"),
    }


def fetch_page(code: str, day: str, page: int) -> dict[str, Any]:
    """One page of the schedule for an airport on one Damascus-local day.

    limit is fixed at 100: the endpoint answers 400 to anything larger, so a wider window is
    only reachable by paging. Paging works without a token, despite the library's docs saying
    higher pages are for paid accounts.
    """
    midnight = int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=TZ).timestamp())
    url = (
        f"{BASE}?code={code}&plugin=&plugin-setting[schedule][mode]="
        f"&plugin-setting[schedule][timestamp]={midnight}"
        f"&page={page}&limit=100&fleet=&token="
    )
    # FR24 rate-limits this endpoint: about thirty requests in quick succession earns a 429,
    # and it arrives without warning partway through a sweep. Backing off and retrying costs a
    # few seconds; not doing it costs whole airports, silently, which is the failure mode worth
    # avoiding in anything scheduled.
    for attempt in range(RETRIES):
        res = cr.get(url, impersonate=IMPERSONATE, timeout=30)
        if res.status_code != 429:
            break
        time.sleep(BACKOFF_SEC * (attempt + 1))
    if res.status_code != 200:
        raise RuntimeError(f"{code}: HTTP {res.status_code} ({len(res.content)} bytes)")
    payload = res.json()
    return (
        payload.get("result", {}).get("response", {})
        .get("airport", {}).get("pluginData", {}).get("schedule", {})
    ) or {}


def fetch_airport(code: str, day: str, pages: int = 1,
                  earlier: bool = False) -> list[tuple[str, dict[str, Any]]]:
    """Every entry across the requested pages, tagged with which side of the board it came from.

    One page is plenty for a Syrian airport — Damascus files about 70 movements a day, well
    inside the 100 cap. It is not enough for a hub: at Dubai the first hundred rows are a slice
    of one morning and contain no Syria flights at all. They start on page 2.

    `earlier` adds page -1, the window before the current one. It is the only way back: FR24
    refuses a past timestamp outright with a 400, mode or no mode. It matters because a
    departure is filed under the day it was *scheduled* to leave and never the day it actually
    left, so a flight due out at 22:50 and delayed past midnight stays on yesterday — where
    today's page 1 will never look. Arrivals are filed by scheduled arrival instead, which is
    why a late landing appears to move itself to the next day.

    Same rule the deployed harvester runs on, so this script can reproduce what the service sees.
    """
    out: list[tuple[str, dict[str, Any]]] = []
    wanted = ([-1] if earlier else []) + list(range(1, pages + 1))
    for page in wanted:
        if page > 1:
            time.sleep(DELAY_SEC)
        sched = fetch_page(code, day, page)
        rows = 0
        for side in ("departures", "arrivals"):
            data = (sched.get(side) or {}).get("data") or []
            rows += len(data)
            out.extend((side, entry) for entry in data)
        # A short page is the end of the schedule, not a hiccup — but only going forward. An
        # empty page -1 says nothing about page 1, so it must not stop the walk.
        if rows == 0 and page > 0:
            break
    return out


def harvest(code: str, day: str, pages: int = 1, only_syria: bool = False,
            earlier: bool = False) -> dict[str, dict[str, list]]:
    """
    Cache rows for one airport, bucketed by date exactly as the browser path buckets them.

    A flight is filed under the local date of its own scheduled time, not the date requested:
    a 23:50 departure landing at 01:30 belongs to two different days at its two ends, and the
    board for either day has to find it.
    """
    by_date: dict[str, dict[str, list]] = {}

    def bucket(d: str) -> dict[str, list]:
        return by_date.setdefault(d, {"arrivals": [], "departures": []})

    seen: set[str] = set()
    for side, entry in fetch_airport(code, day, pages, earlier):
        row = norm_flight(entry)
        if not row:
            continue
        # Paging overlaps at the edges; the FR24 row id is the only stable identity.
        key = f"{row['fr24_id']}|{side}"
        if key in seen:
            continue
        seen.add(key)
        if only_syria and row["dep_iata"] not in SYRIA and row["arr_iata"] not in SYRIA:
            continue
        stamp = row["sched_dep"] if side == "departures" else row["sched_arr"]
        bucket(local_date(stamp))[side].append(row)

    return by_date


# The fields the paid API does not carry, and so the whole reason the browser path exists.
GAP_FIELDS = ["est_dep", "est_arr", "real_dep", "real_arr",
              "dep_terminal", "dep_gate", "arr_terminal", "arr_gate", "arr_baggage"]


def report(code: str, by_date: dict[str, dict[str, list]]) -> None:
    rows = [r for v in by_date.values() for r in v["arrivals"] + v["departures"]]
    print(f"\n{code}  —  {len(rows)} rows across {len(by_date)} date(s)")
    for d in sorted(by_date):
        v = by_date[d]
        print(f"   {d}   {len(v['arrivals']):>3} arr   {len(v['departures']):>3} dep")

    if not rows:
        return
    print("   fields the paid API cannot supply:")
    for f in GAP_FIELDS:
        n = sum(1 for r in rows if r.get(f) not in (None, ""))
        bar = "█" * round(24 * n / len(rows))
        print(f"      {f:13} {n:>3}/{len(rows):<3} {bar}")


def main() -> int:
    p = argparse.ArgumentParser(description="Server-side FR24 airport harvest (read-only)")
    p.add_argument("--airports", default="DAM,ALP,DEZ", help="comma-separated IATA codes")
    p.add_argument("--date", default=datetime.now(TZ).strftime("%Y-%m-%d"),
                   help="Damascus-local day, YYYY-MM-DD (default: today)")
    p.add_argument("--pages", type=int, default=1,
                   help="pages of 100 to pull per airport (limit is capped at 100 server-side). "
                        "1 covers a Syrian airport; a hub needs 5-6 to reach its Syria flights")
    p.add_argument("--delay", type=float, default=1.0,
                   help="seconds between requests (default 1). Sweeping many airports without "
                        "this earns a 429 about thirty requests in")
    p.add_argument("--earlier", action="store_true",
                   help="also pull page -1, the window before now — the only way to reach a "
                        "late-night departure that slipped past midnight onto yesterday")
    p.add_argument("--only-syria", action="store_true",
                   help="keep only flights touching a Syrian airport — for harvesting destinations")
    p.add_argument("--out", help="write the normalised rows to this JSON file")
    args = p.parse_args()

    global DELAY_SEC
    DELAY_SEC = args.delay
    codes = [c.strip().upper() for c in args.airports.split(",") if c.strip()]
    print(f"FR24 harvest — {args.date} — impersonating {IMPERSONATE}, no credentials")

    result: dict[str, Any] = {}
    failures = 0
    for code in codes:
        try:
            by_date = harvest(code, args.date, pages=args.pages,
                              only_syria=args.only_syria, earlier=args.earlier)
            result[code] = by_date
            report(code, by_date)
        except Exception as e:  # noqa: BLE001 — one airport failing must not lose the rest
            failures += 1
            print(f"\n{code}  —  FAILED: {e}")
        if code != codes[-1]:
            time.sleep(DELAY_SEC)

    if args.out:
        with open(args.out, "w") as fh:
            json.dump(result, fh, indent=2)
        print(f"\nwrote {args.out}")

    print("\nNothing was written to Supabase or to either app.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

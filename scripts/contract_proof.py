#!/usr/bin/env python3
"""
Can the harvested data meet the board's contract?

Builds `/api/flightboard`'s exact per-flight payload out of `fr24_staging_flight` plus
`airlines`, and diffs it field by field against the live endpoint. Read-only, writes nothing,
touches no application code — the question is only whether the data is sufficient, and the answer
has to be known before any table is created or any reader is repointed.

Every rule the board applies is reimplemented here rather than approximated, because a diff is
only evidence if the two sides are trying to do the same thing:

  - identity resolved through `airlines.icao -> iata`, which is complete by construction;
  - flights from unknown airlines rejected, the codeshare filter;
  - status derived from the timestamps rather than stored;
  - `arr_next_day` derived, not carried.

Run:  python3 scripts/contract_proof.py [YYYY-MM-DD]
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

SB_URL = os.environ["SUPABASE_URL"].rstrip("/")
SB_KEY = os.environ["SUPABASE_ANON_KEY"]
SITE   = os.environ.get("SITE", "https://www.flysyria.app")

TZ = timezone(timedelta(hours=3))          # Damascus, and Syria does not shift
CONTRACT = [
    "iata_number", "callsign", "airline_name", "airline_iata", "country_flag",
    "dep_iata", "arr_iata", "dep_time_utc", "arr_time_utc", "sched_dep_unix",
    "duration_min", "status", "actual_dep_utc", "actual_arr_utc",
    "revised_dep_utc", "revised_arr_utc", "aircraft_type", "aircraft_reg",
    "dep_terminal", "dep_gate", "arr_terminal", "arr_gate", "arr_baggage",
    "arr_next_day",
]


def get(path: str):
    req = urllib.request.Request(
        f"{SB_URL}/rest/v1/{path}",
        headers={"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"},
    )
    return json.load(urllib.request.urlopen(req, timeout=60))


def hhmm(iso: str | None) -> str | None:
    return iso[11:16] if iso else None


def zulu(iso: str | None) -> str | None:
    """The board's timestamp form: milliseconds and a Z, not an offset."""
    if not iso:
        return None
    d = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.000Z")


# The board's own vocabulary, from `/api/flightboard`. Reproduced rather than invented, or the
# diff would be measuring the difference between two opinions instead of testing the data.
STATUS_RANK = {"Scheduled": 1, "Estimated": 2, "Departed": 5, "Arrived": 8, "Cancelled": 9}


def fr24_word(raw: str | None) -> str:
    """FR24's free text reduced to the board's word."""
    t = (raw or "").lower()
    if "cancel" in t:                          return "Cancelled"
    if "landed" in t or "arrived" in t:        return "Arrived"
    if "departed" in t or "took off" in t:     return "Departed"
    if t.startswith("estimated") or t.startswith("expect"): return "Estimated"
    return "Scheduled"


def derive_status(r: dict, now: datetime) -> str:
    """
    Status is a rendering, not a stored fact — measured across 28 flights seen from both ends,
    where the timestamps agreed and the status strings disagreed 27 times because each airport
    describes the flight from its own role.

    Derived exactly as the board derives it, including its inference that a flight is down once
    actual departure plus effective block time is more than fifteen minutes past.
    """
    word = fr24_word(r.get("status"))
    if r.get("real_arr"):
        return "Arrived"
    dep, est_arr = r.get("real_dep"), r.get("est_arr")
    if dep and est_arr:
        eff = (iso(est_arr) - iso(dep)).total_seconds() / 60
        if eff > 30 and iso(dep) + timedelta(minutes=eff) < now - timedelta(minutes=15):
            return "Arrived"
    if dep and STATUS_RANK.get(word, 0) < STATUS_RANK["Departed"]:
        return "Departed"
    return word


def iso(v: str) -> datetime:
    return datetime.fromisoformat(v.replace("Z", "+00:00"))


def effective_duration(r: dict, sched_dep: datetime, sched_arr: datetime) -> int:
    """Actual departure to revised arrival when both are known — the schedule is padded."""
    if r.get("real_dep") and r.get("est_arr"):
        computed = round((iso(r["est_arr"]) - iso(r["real_dep"])).total_seconds() / 60)
        if computed > 30:
            return computed
    return round((sched_arr - sched_dep).total_seconds() / 60)


def build(rows: list[dict], airlines: dict, day: str) -> dict[str, dict]:
    """The board payload, keyed by flight, from staging rows."""
    icao_to_iata = {a["icao"]: a["iata"] for a in airlines.values() if a.get("icao")}
    now = datetime.now(timezone.utc)
    out: dict[str, dict] = {}

    for r in rows:
        num = r["num"] or ""
        # Identity: FR24 files some carriers under the callsign. Resolve through airlines, which
        # carries both codes for every airline in the scheme.
        iata_num, callsign = num, None
        if len(num) > 3 and num[:3] in icao_to_iata:
            iata_num, callsign = icao_to_iata[num[:3]] + num[3:], num

        prefix = iata_num[:3] if iata_num[:3] in airlines else iata_num[:2]
        al = airlines.get(prefix)
        if not al:
            continue                        # unknown airline: not a flight. The codeshare filter.

        # Both identifiers, always. FR24 files some carriers under one and some under the other;
        # whichever is missing is derived from the airline's pair of codes.
        if callsign is None and al.get("icao"):
            callsign = al["icao"] + iata_num[len(al["iata"]):]

        sched_dep = datetime.fromisoformat(r["sched_dep"].replace("Z", "+00:00"))
        sched_arr = datetime.fromisoformat(r["sched_arr"].replace("Z", "+00:00"))

        out[iata_num] = {
            "iata_number":   iata_num,
            "callsign":      callsign,
            "airline_name":  al.get("name_en"),
            "airline_iata":  al.get("iata"),
            "country_flag":  al.get("country_flag"),
            # FR24 omits the observing airport's own code — an arrival at ALP carries no
            # arr_iata, because from that feed's point of view it is implied. The canonical row
            # has to fill it in from the source, or half the board loses an endpoint.
            "dep_iata":      r["dep_iata"] or r["source_airport"],
            "arr_iata":      r["arr_iata"] or r["source_airport"],
            "dep_time_utc":  hhmm(r["sched_dep"]),
            "arr_time_utc":  hhmm(r["sched_arr"]),
            "sched_dep_unix": int(sched_dep.timestamp()),
            "duration_min":  effective_duration(r, sched_dep, sched_arr),
            "status":        derive_status(r, now),
            "actual_dep_utc": zulu(r.get("real_dep")),
            "actual_arr_utc": zulu(r.get("real_arr")),
            "revised_dep_utc": zulu(r.get("est_dep")),
            "revised_arr_utc": zulu(r.get("est_arr")),
            "aircraft_type": r.get("aircraft"),
            "aircraft_reg":  r.get("reg") or "",
            "dep_terminal":  r.get("dep_terminal"),
            "dep_gate":      r.get("dep_gate"),
            "arr_terminal":  r.get("arr_terminal"),
            "arr_gate":      r.get("arr_gate"),
            # Derived, never carried: a flight due today that lands after midnight belongs at the
            # end of today rather than the start.
            "arr_next_day":  sched_arr.astimezone(TZ).date() > sched_dep.astimezone(TZ).date(),
            "arr_baggage":   r.get("arr_baggage"),
        }
    return out


def main() -> int:
    day = sys.argv[1] if len(sys.argv) > 1 else datetime.now(TZ).strftime("%Y-%m-%d")

    airlines = {a["iata"]: a for a in get("airlines?select=iata,icao,name_en,country_flag")}
    rows = get(
        "fr24_staging_flight?select=*"
        f"&flight_date=eq.{day}&source_airport=in.(DAM,ALP,DEZ)"
    )
    mine = build(rows, airlines, day)

    live = json.load(urllib.request.urlopen(f"{SITE}/api/flightboard?date={day}", timeout=60))
    theirs = {f["iata_number"]: f for f in (live.get("flights") or [])}

    print(f"{day}   staging {len(rows)} rows -> {len(mine)} flights   |   live board {len(theirs)}")

    only_mine = sorted(set(mine) - set(theirs))
    only_live = sorted(set(theirs) - set(mine))
    shared = sorted(set(mine) & set(theirs))
    print(f"in both {len(shared)}   only from staging {len(only_mine)}   only on the board {len(only_live)}")
    if only_mine: print("  extra:  ", ", ".join(only_mine[:12]))
    if only_live: print("  missing:", ", ".join(only_live[:12]))

    diffs = Counter()
    examples: dict[str, tuple] = {}
    for k in shared:
        for f in CONTRACT:
            a, b = mine[k].get(f), theirs[k].get(f)
            if a != b:
                diffs[f] += 1
                examples.setdefault(f, (k, a, b))

    print(f"\n{'field':18}{'differs':>9}  example")
    for f in CONTRACT:
        n = diffs[f]
        if not n:
            print(f"{f:18}{'—':>9}")
            continue
        k, a, b = examples[f]
        print(f"{f:18}{n:>9}  {k}: staging={json.dumps(a)[:26]} live={json.dumps(b)[:26]}")

    agree = sum(1 for k in shared if all(mine[k].get(f) == theirs[k].get(f) for f in CONTRACT))
    print(f"\n{agree}/{len(shared)} flights identical across all {len(CONTRACT)} contract fields")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

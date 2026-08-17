"""
Recording where aircraft actually flew, and turning that into corridors.

68 of the 70 rows in `route_paths` have observed_count 0: they were hand-imported from a single
FR24 track each, by whoever happened to pick that flight. That is why DAM-JED matches Syrian Air
and is about 170 km wrong for flynas on every one of its thirteen flights a fortnight — nothing
has ever compared the stored path against what is being flown.

Two halves, both here:

  record()   every observed fix into flight_track_samples, with progress measured along the
             great circle so it owes nothing to a stored corridor that may itself be wrong
  learn()    per (dep, arr, operator), the per-bin median across flights -> route_paths_learned

Writes to its OWN tables. route_paths belongs to the website's map, and moving those corridors
would silently change what production draws.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx

from geo import gc_fraction, consensus_path, haversine_km

SAMPLE_WINDOW_DAYS = 60          # rolling: airspace here changes politically, not seasonally
MIN_FLIGHTS = 2                  # below this there is no consensus, only an anecdote
OUTLIER_KM = 60                  # a flight this far from the consensus is a reroute, not noise


async def record(client, sb, sb_headers: dict, flights: list[dict], aps: dict) -> int:
    """
    One row per airborne observed fix. Cheap, append-only, and unconditional — a route with no
    corridor is exactly the one we most need samples for, and `route_path_samples` cannot hold
    those at all because its s and off_path_km are NOT NULL.
    """
    rows = []
    for f in flights:
        p = f.get("position") or {}
        if p.get("pos_source") != "observed" or p.get("lat") is None:
            continue
        if p.get("on_ground") is True:
            continue                       # taxi tracks are not a route
        dep, arr = f.get("dep_iata"), f.get("arr_iata")
        dc, ac = aps.get(dep or ""), aps.get(arr or "")
        cs = (f.get("callsign") or "").strip().upper()
        if not (dep and arr and dc and ac and cs and p.get("fix_at")):
            continue
        rows.append({
            "callsign": cs,
            "dep_iata": dep,
            "arr_iata": arr,
            "flight_date": f.get("flight_date"),
            "seen_at": p["fix_at"],
            "lat": p["lat"], "lon": p["lon"],
            "gc_fraction": gc_fraction(dc, ac, p["lat"], p["lon"]),
            "alt_ft": p.get("altitude_ft"),
            "gs_kts": p.get("ground_speed_kts"),
            "track_deg": p.get("track_deg"),
            "source": p.get("source"),
        })
    if not rows:
        return 0
    # Duplicates ignored rather than raised: the document is cached, so consecutive builds offer
    # the same fix again, and the unique index is what makes that harmless.
    r = await client.post(
        f"{sb}/rest/v1/flight_track_samples",
        headers={**sb_headers, "Content-Type": "application/json",
                 "Prefer": "resolution=ignore-duplicates,return=minimal"},
        json=rows, timeout=30,
    )
    return len(rows) if r.status_code < 300 else 0


async def learn(client, sb, sb_headers: dict, aps: dict) -> list[dict]:
    """
    Turn the samples into corridors. Intended for a scheduled call, not a request.

    Grouped by (dep, arr, operator) because that is where the variance lives: the same airline's
    flight numbers agree within about 5 km on thirteen of fourteen routes measured, while two
    airlines on one city pair differ by 170.
    """
    since = quote((datetime.now(timezone.utc) - timedelta(days=SAMPLE_WINDOW_DAYS)).isoformat(),
                  safe="")
    rows = await _get(client, sb, sb_headers,
                      "flight_track_samples?select=callsign,operator,dep_iata,arr_iata,"
                      f"flight_date,lat,lon,gc_fraction&seen_at=gte.{since}&order=id")

    # (dep, arr, operator) -> flight key -> points
    grouped: dict[tuple, dict[tuple, list[dict]]] = {}
    for r in rows:
        key = (r["dep_iata"], r["arr_iata"], r["operator"])
        flight = (r["callsign"], r["flight_date"])
        grouped.setdefault(key, {}).setdefault(flight, []).append(r)

    written = []
    for (dep, arr, op), flights in grouped.items():
        tracks = [pts for pts in flights.values() if len(pts) >= 8]
        if len(tracks) < MIN_FLIGHTS:
            continue

        path = consensus_path(tracks)
        if not path:
            continue

        # Which flights actually agree with it. A reroute is real and belongs in the samples,
        # but not in the consensus — SYR342 flew KWI-DAM 231 km from the others one day.
        kept, outliers = [], 0
        for key, pts in flights.items():
            if len(pts) < 8:
                continue
            offs = sorted(_off_path_km(path, p) for p in pts)
            if offs and offs[len(offs) // 2] > OUTLIER_KM:
                outliers += 1
            else:
                kept.append(key)

        if len(kept) >= MIN_FLIGHTS and outliers:
            # Recompute without them, so one bad day cannot even half-shift the median.
            path = consensus_path([flights[k] for k in kept]) or path

        written.append({
            "dep_iata": dep, "arr_iata": arr, "operator": op,
            "waypoints": path,
            "observed_count": len(kept) or len(tracks),
            "sample_count": sum(len(p) for p in flights.values()),
            "source_flights": [f"{c}/{d}" for c, d in kept][:50],
            "outliers_excluded": outliers,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })

    for i in range(0, len(written), 50):
        await client.post(
            f"{sb}/rest/v1/route_paths_learned",
            headers={**sb_headers, "Content-Type": "application/json",
                     "Prefer": "resolution=merge-duplicates,return=minimal"},
            json=written[i:i + 50], timeout=60,
        )
    return written


def _off_path_km(path: list[dict], point: dict) -> float:
    """Nearest waypoint distance. Coarse on purpose — this only has to sort reroutes from noise."""
    return min(haversine_km((w["lat"], w["lon"]), (point["lat"], point["lon"])) for w in path)


PAGE = 1000          # PostgREST's server-side ceiling, whatever the query string asks for


async def _get(client, sb, sb_headers, q: str) -> list[dict]:
    """
    Every row, in pages.

    PostgREST caps a response at 1,000 rows and ignores a larger `limit` in the query string —
    silently, with a 200. The first version of this asked for 200,000, got 1,000, and produced
    zero corridors from 2,837 samples because almost every route came back with one usable track
    instead of two. A truncation that looks like a successful answer is worse than an error.

    Paged by Range rather than offset: PostgREST answers it natively and reports the total in
    Content-Range, so a short page is a real end rather than a guess.
    """
    out: list[dict] = []
    start = 0
    while True:
        r = await client.get(
            f"{sb}/rest/v1/{q}",
            headers={**sb_headers, "Range-Unit": "items", "Range": f"{start}-{start + PAGE - 1}"},
            timeout=120,
        )
        r.raise_for_status()
        page = r.json()
        out.extend(page)
        if len(page) < PAGE:
            return out
        start += PAGE

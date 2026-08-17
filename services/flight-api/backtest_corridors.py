"""
Does a learned corridor actually put an aircraft closer to where it is?

That is the strategy's real claim, and until now we have only measured whether corridors get
BUILT. A corridor that exists but projects no better than a great circle would be a lot of
machinery for nothing.

HELD OUT, not in-sample. Learning a corridor from a flight and then scoring it on that same
flight measures memorisation. Each leg is removed in turn, the corridor is rebuilt from the
others, and the error is measured against the leg the corridor has never seen. Only routes with
three or more legs can be tested this way, because MIN_FLIGHTS is 2 and holding one out of two
leaves nothing to learn from.

For every observed fix on the held-out leg:

    corridor error   how far the learned path at that progress is from where the aircraft was
    great circle     the same, for the straight line we would otherwise draw

Read-only. Nothing is written.
"""

import os
import statistics
import sys
import urllib.parse
import urllib.request
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.expanduser("~/FlightTracker/services/flight-api"))
from geo import (bins_for_route, consensus_path, great_circle_path,      # noqa: E402
                 haversine_km, interpolate_path, position_on_route)

SB = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ["SUPABASE_ANON_KEY"]
HEAD = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}


def get(path):
    out, start = [], 0
    while True:
        req = urllib.request.Request(f"{SB}/rest/v1/{path}",
                                     headers={**HEAD, "Range": f"{start}-{start + 999}"})
        with urllib.request.urlopen(req, timeout=60) as r:
            page = json.load(r)
        out += page
        if len(page) < 1000:
            return out
        start += 1000


def main():
    aps = {a["iata"]: (a["lat"], a["lon"]) for a in
           get("airports?select=iata,lat,lon&lat=not.is.null")}
    since = urllib.parse.quote(
        (datetime.now(timezone.utc) - timedelta(days=60)).isoformat(), safe="")
    rows = get("flight_track_samples?select=callsign,operator,dep_iata,arr_iata,flight_date,"
               f"lat,lon,gc_fraction&seen_at=gte.{since}&order=id")

    grouped = defaultdict(lambda: defaultdict(list))
    for r in rows:
        grouped[(r["dep_iata"], r["arr_iata"], r["operator"])][
            (r["callsign"], r["flight_date"])].append(r)

    print(f"{len(rows)} samples\n")
    print(f"{'route':14} {'op':5} {'held-out leg':22} {'fixes':>6} "
          f"{'corridor':>10} {'great circle':>13} {'better by':>10}")
    print("-" * 88)

    corridor_all, gc_all, wins = [], [], 0
    tested = 0
    for (dep, arr, op), legs in sorted(grouped.items()):
        usable = {k: v for k, v in legs.items() if len(v) >= 8}
        if len(usable) < 3:
            continue                          # cannot hold one out and still have a consensus
        dc, ac = aps.get(dep), aps.get(arr)
        if not dc or not ac:
            continue
        nbins = bins_for_route(haversine_km(dc, ac))
        gc = great_circle_path(dc, ac)

        for held, pts in usable.items():
            others = [v for k, v in usable.items() if k != held]
            path = consensus_path(others, bins=nbins)
            if not path:
                continue
            c_err, g_err = [], []
            for p in pts:
                f = p["gc_fraction"]
                truth = (p["lat"], p["lon"])
                cpos = position_on_route(path, gc, f)
                gpos = interpolate_path(gc, f)
                if cpos:
                    c_err.append(haversine_km(cpos, truth))
                if gpos:
                    g_err.append(haversine_km(gpos, truth))
            if not c_err or not g_err:
                continue
            cm, gm = statistics.median(c_err), statistics.median(g_err)
            corridor_all += c_err
            gc_all += g_err
            tested += 1
            if cm < gm:
                wins += 1
            print(f"{dep+'->'+arr:14} {op:5} {held[0]+' '+str(held[1]):22} {len(pts):6} "
                  f"{cm:9.1f}km {gm:12.1f}km {gm-cm:9.1f}km")

    if not corridor_all:
        print("\nnothing had three legs yet — cannot hold one out")
        return
    print("-" * 88)
    cm, gm = statistics.median(corridor_all), statistics.median(gc_all)
    print(f"{'ALL':14} {'':5} {str(tested)+' held-out legs':22} {len(corridor_all):6} "
          f"{cm:9.1f}km {gm:12.1f}km {gm-cm:9.1f}km")
    print(f"\ncorridor closer on {wins} of {tested} held-out legs")
    print(f"median error   corridor {cm:.1f} km   great circle {gm:.1f} km")
    if gm > 0:
        print(f"improvement    {100*(gm-cm)/gm:.0f}%")


if __name__ == "__main__":
    main()

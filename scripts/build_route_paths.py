#!/usr/bin/env python3
"""
Build canonical route paths for each OD pair from FR24 historical tracks.
Stores results in Supabase route_paths table.

Usage:
  python3 scripts/build_route_paths.py [DEP_IATA ARR_IATA]
  python3 scripts/build_route_paths.py         # builds all routes
  python3 scripts/build_route_paths.py DAM DXB  # single route
"""

import json, math, os, sys, time
from datetime import datetime, timezone
import urllib.request, urllib.parse

FR24_KEY = os.environ.get("FR24_KEY", "")
SB_URL   = os.environ.get("SUPABASE_URL", "")
SB_KEY   = os.environ.get("SUPABASE_ANON_KEY", "")

WAYPOINTS_TARGET = 13   # number of waypoints per canonical path (including dep/arr)
FLIGHTS_PER_ROUTE = 3   # how many historical flights to average
DATE_FROM = "2026-07-07T00:00:00Z"
DATE_TO   = "2026-07-20T23:59:59Z"
SLEEP_BETWEEN_CALLS = 2.5  # seconds between FR24 API calls

# FR24 flight IDs to skip (corrupted tracks)
EXCLUDE_IDS = {
    "40b69505",  # VF591 ESB→DAM Jul 17 — anomalous 3h45m duration, ends near Latakia
}

# IATA → ICAO for filtering FR24 summaries by orig_icao
IATA_TO_ICAO = {
    "DAM": "OSDI",
    "ALP": "OSAP",
    "IST": "LTFM",
    "SAW": "LTFJ",
    "DXB": "OMDB",
    "SHJ": "OMSJ",
    "AUH": "OMAA",
    "DOH": "OTHH",
    "KWI": "OKBK",
    "RUH": "OERK",
    "JED": "OEJN",
    "AMM": "OJAI",
    "BGW": "ORBI",
    "EBL": "ORER",
    "MCT": "OOMS",
    "DMM": "OEDF",
    "AMS": "EHAM",
    "BUH": "LROP",
    "OTP": "LROP",
    "ESB": "LTAC",
    "MJI": "HLMB",
    "TIP": "HLLT",
    "EVN": "UDYZ",
}

# All OD pairs — one representative IATA flight number per direction.
# Multiple airlines on the same route share the same canonical path.
# Flight numbers verified from flight_schedule + flight_lookup tables.
ROUTES = [
    # ── Damascus ↔ Istanbul ──────────────────────────────────────────────
    ("DAM", "IST", "RB443"),   # SYR443
    ("IST", "DAM", "RB444"),   # SYR444

    # ── Damascus ↔ Dubai ─────────────────────────────────────────────────
    ("DAM", "DXB", "RB515"),   # SYR515
    ("DXB", "DAM", "RB516"),   # SYR516

    # ── Damascus ↔ Sharjah ───────────────────────────────────────────────
    ("DAM", "SHJ", "RB501"),   # SYR501
    ("SHJ", "DAM", "RB502"),   # SYR502

    # ── Damascus ↔ Abu Dhabi ─────────────────────────────────────────────
    ("DAM", "AUH", "RB503"),   # SYR503
    ("AUH", "DAM", "RB504"),   # SYR504

    # ── Damascus ↔ Doha ──────────────────────────────────────────────────
    ("DAM", "DOH", "RB521"),   # SYR521
    ("DOH", "DAM", "RB522"),   # SYR522

    # ── Damascus ↔ Kuwait ────────────────────────────────────────────────
    ("DAM", "KWI", "RB341"),   # SYR341
    ("KWI", "DAM", "RB342"),   # SYR342

    # ── Damascus ↔ Riyadh ────────────────────────────────────────────────
    ("DAM", "RUH", "RB389"),   # SYR389
    ("RUH", "DAM", "RB390"),   # SYR390

    # ── Damascus ↔ Jeddah ────────────────────────────────────────────────
    ("DAM", "JED", "RB381"),   # SYR381
    ("JED", "DAM", "RB382"),   # SYR382

    # ── Damascus ↔ Amman ─────────────────────────────────────────────────
    ("DAM", "AMM", "RJ436"),   # RJA436
    ("AMM", "DAM", "RJ437"),   # RJA437

    # ── Damascus ↔ Baghdad ───────────────────────────────────────────────
    ("DAM", "BGW", "FYC501"),
    ("BGW", "DAM", "FYC502"),

    # ── Damascus ↔ Erbil ─────────────────────────────────────────────────
    ("DAM", "EBL", "FYC521"),
    ("EBL", "DAM", "FYC522"),

    # ── Damascus ↔ Muscat ────────────────────────────────────────────────
    ("DAM", "MCT", "FYC781"),
    ("MCT", "DAM", "FYC782"),

    # ── Damascus ↔ Dammam ────────────────────────────────────────────────
    ("DAM", "DMM", "FYC831"),
    ("DMM", "DAM", "FYC832"),

    # ── Damascus ↔ Amsterdam ─────────────────────────────────────────────
    ("DAM", "AMS", "RB272"),   # SYR272
    ("AMS", "DAM", "RB271"),   # SYR271

    # ── Damascus ↔ Istanbul Sabiha (Cham Wings) ──────────────────────────
    ("DAM", "SAW", "FYC485"),
    ("SAW", "DAM", "FYC486"),

    # ── Damascus ↔ Tripoli (Mitiga) ──────────────────────────────────────
    ("DAM", "MJI", "FYC361"),
    ("MJI", "DAM", "FYC362"),

    # ── Damascus ↔ Bucharest ─────────────────────────────────────────────
    ("DAM", "BUH", "DN542"),   # JOC542
    ("BUH", "DAM", "DN541"),   # JOC541

    # ── Damascus ↔ Ankara ────────────────────────────────────────────────
    ("DAM", "ESB", "VF592"),   # TKJ592
    ("ESB", "DAM", "VF591"),   # TKJ591

    # ── Aleppo ↔ Istanbul ────────────────────────────────────────────────
    ("ALP", "IST", "RB445"),   # SYR445
    ("IST", "ALP", "RB444"),   # SYR444 (same aircraft, continues IST→ALP after IST→DAM)

    # ── Aleppo ↔ Dubai ───────────────────────────────────────────────────
    ("ALP", "DXB", "FYC725"),
    ("DXB", "ALP", "FYC726"),

    # ── Aleppo ↔ Sharjah ─────────────────────────────────────────────────
    ("ALP", "SHJ", "G9352"),   # ABY352
    ("SHJ", "ALP", "G9351"),   # ABY351

    # ── Aleppo ↔ Kuwait ──────────────────────────────────────────────────
    ("ALP", "KWI", "J9176"),   # JZR176
    ("KWI", "ALP", "J9175"),   # JZR175

    # ── Aleppo ↔ Riyadh ──────────────────────────────────────────────────
    ("ALP", "RUH", "RB389"),   # SYR389 (same number, different dep)
    ("RUH", "ALP", "RB390"),   # SYR390

    # ── Aleppo ↔ Jeddah ──────────────────────────────────────────────────
    ("ALP", "JED", "RB381"),   # SYR381
    ("JED", "ALP", "RB382"),   # SYR382

    # ── Aleppo ↔ Amman ───────────────────────────────────────────────────
    ("ALP", "AMM", "RJ432"),   # RJA432
    ("AMM", "ALP", "RJ431"),   # RJA431

    # ── Aleppo ↔ Erbil ───────────────────────────────────────────────────
    ("ALP", "EBL", "FYC525"),
    ("EBL", "ALP", "FYC526"),

    # ── Aleppo ↔ Yerevan ─────────────────────────────────────────────────
    ("ALP", "EVN", "FYC455"),
    ("EVN", "ALP", "FYC456"),

    # ── Aleppo ↔ Istanbul Sabiha ─────────────────────────────────────────
    ("ALP", "SAW", "FYC491"),
    ("SAW", "ALP", "FYC492"),

    # ── Aleppo ↔ Bucharest ───────────────────────────────────────────────
    ("ALP", "OTP", "DN552"),   # JOC552
    ("OTP", "ALP", "DN551"),   # JOC551
]

# Deduplicate OD pairs (multiple airlines on same route → share one path)
seen_routes = {}
for dep, arr, flight in ROUTES:
    key = (dep, arr)
    if key not in seen_routes:
        seen_routes[key] = []
    seen_routes[key].append(flight)


def fr24_get(path: str) -> dict | list:
    url = f"https://fr24api.flightradar24.com/api/{path}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "Accept-Version": "v1",
        "Authorization": f"Bearer {FR24_KEY}",
        "User-Agent": "curl/8.4.0",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def sb_upsert(table: str, rows: list):
    body = json.dumps(rows).encode()
    req = urllib.request.Request(
        f"{SB_URL}/rest/v1/{table}",
        data=body,
        method="POST",
        headers={
            "apikey": SB_KEY,
            "Authorization": f"Bearer {SB_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status


def haversine_nm(lat1, lon1, lat2, lon2) -> float:
    R = 3440.065  # nautical miles
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return 2 * R * math.asin(math.sqrt(a))


def get_fr24_ids(flight_num: str, dep_iata: str, arr_iata: str) -> list[dict]:
    """Get up to FLIGHTS_PER_ROUTE completed flights, filtered by both departure and arrival airport."""
    path = (
        f"flight-summary/light"
        f"?flights={urllib.parse.quote(flight_num)}"
        f"&flight_datetime_from={DATE_FROM}"
        f"&flight_datetime_to={DATE_TO}"
    )
    try:
        data = fr24_get(path)
        flights = data.get("data", [])
        complete = [f for f in flights if f.get("flight_ended") and f.get("datetime_takeoff") and f.get("datetime_landed") and f.get("fr24_id") not in EXCLUDE_IDS]

        dep_icao = IATA_TO_ICAO.get(dep_iata)
        arr_icao = IATA_TO_ICAO.get(arr_iata)

        if dep_icao:
            filtered = [f for f in complete if f.get("orig_icao") == dep_icao]
            if filtered:
                complete = filtered
            else:
                print(f"    (no orig_icao={dep_icao} match, using all {len(complete)})")

        if arr_icao:
            filtered = [f for f in complete if f.get("dest_icao_actual") == arr_icao]
            if filtered:
                complete = filtered
            else:
                print(f"    (no dest_icao_actual={arr_icao} match, keeping {len(complete)})")

        return complete[:FLIGHTS_PER_ROUTE]
    except Exception as e:
        print(f"    summary error for {flight_num}: {e}")
        return []


def get_track(fr24_id: str, takeoff_str: str, landed_str: str) -> list[dict]:
    """Fetch track and return airborne-only points with elapsed fraction."""
    try:
        data = fr24_get(f"flight-tracks?flight_id={fr24_id}")
        tracks = data[0]["tracks"] if data else []
    except Exception as e:
        print(f"    track error {fr24_id}: {e}")
        return []

    t0 = datetime.fromisoformat(takeoff_str.replace("Z", "+00:00")).timestamp()
    t1 = datetime.fromisoformat(landed_str.replace("Z", "+00:00")).timestamp()
    duration = t1 - t0
    if duration <= 0:
        return []

    airborne = []
    for p in tracks:
        ts = datetime.fromisoformat(p["timestamp"].replace("Z", "+00:00")).timestamp()
        if t0 <= ts <= t1:
            f = (ts - t0) / duration
            airborne.append({"lat": p["lat"], "lon": p["lon"], "f": round(f, 4)})

    # Ensure endpoints
    if airborne and airborne[0]["f"] > 0.01:
        airborne.insert(0, {"lat": airborne[0]["lat"], "lon": airborne[0]["lon"], "f": 0.0})
    if airborne and airborne[-1]["f"] < 0.99:
        airborne.append({"lat": airborne[-1]["lat"], "lon": airborne[-1]["lon"], "f": 1.0})

    return airborne


def downsample(points: list[dict], n: int) -> list[dict]:
    """Pick n evenly-spaced points by elapsed fraction."""
    if not points:
        return []
    result = []
    for i in range(n):
        target_f = i / (n - 1)
        # Find nearest point to target_f
        best = min(points, key=lambda p: abs(p["f"] - target_f))
        result.append({"lat": round(best["lat"], 5), "lon": round(best["lon"], 5), "f": round(target_f, 4)})
    return result


def average_paths(paths: list[list[dict]]) -> list[dict]:
    """Average multiple downsampled paths (all same length) into one canonical path."""
    if not paths:
        return []
    n = len(paths[0])
    result = []
    for i in range(n):
        avg_lat = sum(p[i]["lat"] for p in paths) / len(paths)
        avg_lon = sum(p[i]["lon"] for p in paths) / len(paths)
        result.append({"lat": round(avg_lat, 5), "lon": round(avg_lon, 5), "f": paths[0][i]["f"]})
    return result


def total_dist(waypoints: list[dict]) -> float:
    total = 0.0
    for i in range(1, len(waypoints)):
        total += haversine_nm(waypoints[i-1]["lat"], waypoints[i-1]["lon"],
                              waypoints[i]["lat"], waypoints[i]["lon"])
    return round(total, 1)


def build_route(dep_iata: str, arr_iata: str, flight_nums: list[str]):
    print(f"\n{'='*50}")
    print(f"Route: {dep_iata} → {arr_iata}  (flights: {', '.join(flight_nums)})")

    all_downsampled = []
    source_ids = []

    for flight_num in flight_nums:
        print(f"  Querying {flight_num}…")
        time.sleep(SLEEP_BETWEEN_CALLS)
        flights = get_fr24_ids(flight_num, dep_iata, arr_iata)
        if not flights:
            print(f"    No completed flights found")
            continue

        for flight in flights:
            fr24_id = flight["fr24_id"]
            print(f"    {fr24_id}  {flight['datetime_takeoff']} → {flight['datetime_landed']}")
            track = get_track(fr24_id, flight["datetime_takeoff"], flight["datetime_landed"])
            if len(track) < 5:
                print(f"      Too few airborne points ({len(track)}), skipping")
                continue
            print(f"      {len(track)} airborne points")
            ds = downsample(track, WAYPOINTS_TARGET)
            all_downsampled.append(ds)
            source_ids.append(fr24_id)
            time.sleep(SLEEP_BETWEEN_CALLS)

    if not all_downsampled:
        print(f"  No valid tracks — skipping route")
        return False

    canonical = average_paths(all_downsampled)
    dist_nm   = total_dist(canonical)
    print(f"  Canonical path: {len(canonical)} waypoints, {dist_nm} NM")
    print(f"  First: {canonical[0]}  Last: {canonical[-1]}")

    status = sb_upsert("route_paths", [{
        "dep_iata":       dep_iata,
        "arr_iata":       arr_iata,
        "waypoints":      canonical,
        "total_dist_nm":  dist_nm,
        "source_flights": source_ids,
        "updated_at":     datetime.now(timezone.utc).isoformat(),
    }])
    print(f"  Supabase upsert: HTTP {status}")
    return True


def main():
    if not FR24_KEY:
        print("Set FR24_KEY env variable"); sys.exit(1)
    if not SB_URL or not SB_KEY:
        print("Set SUPABASE_URL and SUPABASE_ANON_KEY env variables"); sys.exit(1)

    target = None
    if len(sys.argv) == 3:
        target = (sys.argv[1].upper(), sys.argv[2].upper())

    for (dep, arr), flights in seen_routes.items():
        if target and (dep, arr) != target:
            continue
        build_route(dep, arr, flights)
        time.sleep(SLEEP_BETWEEN_CALLS)

    print("\nDone.")


if __name__ == "__main__":
    main()

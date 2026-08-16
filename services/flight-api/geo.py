"""
Where an aeroplane is, decided once, on the server.

Every position defect this project has had was two implementations of this question disagreeing:
the site drawing FYC361 where its fix said and the phone drawing it 190 km away on the corridor;
one PathTracker closing a 298 km error while the other grew it to 440 km; a countdown damped by
the server and damped again by the client, so the site held 12:07 while the phone read 12:07,
12:09, 12:07. The values were rarely in dispute. The number of opinions was.

So everything here is a PURE FUNCTION. No accumulated progress scalar, no rate, no chasing flag,
no correction factor. Those exist in the client trackers only because they carry state between
polls, and carried state is what drifts — both from reality and from the other surface's copy of
it. A function of (schedule, corridor, now) cannot drift: two callers asking at the same instant
get the same answer because there is nothing else to get. It is also reproducible, which the
client trackers never were: a marker in the wrong place can be replayed from its inputs.

No I/O, no clock reads, no globals. `now` is always a parameter.
"""

from __future__ import annotations

import math

# ── Fix plausibility ──────────────────────────────────────────────────────────

# Above this an aircraft is unambiguously airborne rather than parked or taxiing.
AIRBORNE_FT = 10_000
# No aircraft holds 10,000 ft below this. Stalling speeds are far above it.
MIN_AIRBORNE_KT = 50
# About a metre. Far finer than two aircraft ever genuinely share.
COORD_DP = 5


def _num(v) -> float | None:
    """A finite number, or nothing. bool is excluded: True would otherwise pass as 1.0."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def is_plausible_fix(fix: dict) -> bool:
    """
    Could an aeroplane actually be here, doing this?

    On 15 and 16 Aug the aggregator served 47 distinct aircraft — Qatar, Turkish, Saudia,
    Jazeera, flyadeal, MEA, Condor, flydubai — every one of them stamped 31.71711, 35.999341
    with gs 0.7 and track 0, while their altitudes stayed real and distinct: 39,000, 37,025,
    33,000 ft. The raw records carried identical `dst` and `dir` as well, so upstream had
    computed both from a constant. Only position and velocity were replaced; ias, mach and
    true_heading were genuine throughout.

    Those coordinates are Queen Alia airport, Amman. The website survived it because its map
    draws the corridor and treats a fix as a nudge; the app draws the fix and put a dozen
    airliners in a car park in Jordan.

    A cruising aircraft reporting 0.7 knots is not a slow aircraft. It is a null wearing a
    number. Nothing here hardcodes Amman — the next sentinel will be somewhere else.
    """
    lat = _num(fix.get("lat"))
    lon = _num(fix.get("lon"))
    if lat is None or lon is None:
        return False
    if abs(lat) > 90 or abs(lon) > 180:
        return False
    # 0,0 is the Gulf of Guinea, and far more often an uninitialised pair than a position.
    if lat == 0 and lon == 0:
        return False

    alt = _num(fix.get("alt_baro"))
    if alt is None:
        alt = _num(fix.get("altitude_ft"))
    gs = _num(fix.get("gs"))
    if gs is None:
        gs = _num(fix.get("ground_speed_kts"))
    if alt is not None and gs is not None and alt > AIRBORNE_FT and gs < MIN_AIRBORNE_KT:
        return False

    return True


def drop_sentinel_fixes(fixes: list[dict], key: str = "hex") -> list[dict]:
    """
    Discard any coordinate that more than one aircraft claims at the same moment.

    The plausibility rule above catches a sentinel that also clobbers speed. It does not catch
    one that leaves speed intact — PER002 came back from the same corrupt sweep at gs 456,
    entirely reasonable on its own, and still sitting on Queen Alia with nineteen others.

    Two aircraft do not occupy the same square metre. When a coordinate is claimed by two
    distinct identities in one sweep it is a placeholder, and every row carrying it goes —
    including the one that might have been real, because there is no way to tell which. Self
    tuning, and free when the feed is healthy.

    `key` is whatever identifies an airframe in the rows being filtered: hex for the aggregator
    feed, callsign for aircraft_last_seen, which has no hex.
    """
    claimants: dict[tuple, set] = {}
    for i, f in enumerate(fixes):
        lat, lon = _num(f.get("lat")), _num(f.get("lon"))
        if lat is None or lon is None:
            continue
        k = (round(lat, COORD_DP), round(lon, COORD_DP))
        # A row with no identity counts as its own claimant, so a feed that omits the key
        # cannot hide a sentinel behind one empty identity.
        claimants.setdefault(k, set()).add(f.get(key) or f"anon:{i}")

    out = []
    for f in fixes:
        lat, lon = _num(f.get("lat")), _num(f.get("lon"))
        if lat is None or lon is None:
            out.append(f)                      # nothing to judge; is_plausible_fix handles it
            continue
        if len(claimants[(round(lat, COORD_DP), round(lon, COORD_DP))]) < 2:
            out.append(f)
    return out


# ── Corridor geometry ─────────────────────────────────────────────────────────

def _slerp(a: tuple[float, float], b: tuple[float, float], t: float) -> tuple[float, float]:
    """
    Great-circle interpolation between two points.

    Spherical rather than linear because linear interpolation of latitude and longitude bends
    away from the route: over DAM–DXB it is tens of kilometres out in the middle, which on a map
    reads as an aircraft flying beside its own path.
    """
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])

    d = 2 * math.asin(math.sqrt(
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    ))
    if d < 1e-12:
        return a

    A = math.sin((1 - t) * d) / math.sin(d)
    B = math.sin(t * d) / math.sin(d)
    x = A * math.cos(lat1) * math.cos(lon1) + B * math.cos(lat2) * math.cos(lon2)
    y = A * math.cos(lat1) * math.sin(lon1) + B * math.cos(lat2) * math.sin(lon2)
    z = A * math.sin(lat1) + B * math.sin(lat2)
    return (math.degrees(math.atan2(z, math.hypot(x, y))),
            math.degrees(math.atan2(y, x)))


def interpolate_path(waypoints: list[dict], f: float) -> tuple[float, float] | None:
    """
    The point at fraction `f` along a corridor.

    Waypoints carry their own fraction `f` — the share of the route flown by the time they are
    reached — so an evenly spaced list and a bunched one both behave. Ported from the
    TypeScript both clients use today, deliberately unchanged in behaviour so a position computed
    here matches one computed there while both exist.
    """
    pts = [w for w in waypoints if _num(w.get("lat")) is not None and _num(w.get("lon")) is not None]
    if not pts:
        return None
    if len(pts) == 1:
        return (pts[0]["lat"], pts[0]["lon"])

    fs = [_num(w.get("f")) for w in pts]
    if any(v is None for v in fs):
        # No fractions stored: fall back to even spacing rather than refusing to draw.
        fs = [i / (len(pts) - 1) for i in range(len(pts))]

    if f <= fs[0]:
        return (pts[0]["lat"], pts[0]["lon"])
    if f >= fs[-1]:
        return (pts[-1]["lat"], pts[-1]["lon"])

    lo, hi = 0, len(pts) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if fs[mid] <= f:
            lo = mid
        else:
            hi = mid

    span = fs[hi] - fs[lo]
    if span < 1e-9:
        return (pts[lo]["lat"], pts[lo]["lon"])
    return _slerp((pts[lo]["lat"], pts[lo]["lon"]),
                  (pts[hi]["lat"], pts[hi]["lon"]),
                  (f - fs[lo]) / span)


def bearing_from_path(waypoints: list[dict], f: float) -> float | None:
    """
    Which way the corridor points at fraction `f`.

    Sampled either side of the point rather than taken from the enclosing segment, so the nose
    turns smoothly through a waypoint instead of snapping. The marker's heading and its motion
    come from this one function; when they came from two, they drifted 57 degrees apart on a
    Damascus approach and the aircraft appeared to fly sideways.
    """
    dt = 0.005
    a = interpolate_path(waypoints, max(0.0, f - dt))
    b = interpolate_path(waypoints, min(1.0, f + dt))
    if a is None or b is None or a == b:
        return None
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlon = math.radians(b[1] - a[1])
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def great_circle_path(dep: tuple[float, float], arr: tuple[float, float]) -> list[dict]:
    """
    A two-point corridor, for an OD pair no path has ever been recorded for.

    The same shape as a real corridor on purpose: interpolate_path treats it identically, so
    there is no second branch anywhere downstream and no second way to ask the question.
    """
    return [{"lat": dep[0], "lon": dep[1], "f": 0.0},
            {"lat": arr[0], "lon": arr[1], "f": 1.0}]


def project_position(dep_ms: float, arr_ms: float, path: list[dict], now_ms: float) -> dict | None:
    """
    Where a flight should be, from its schedule and its corridor. The whole of the projection.

    Three lines of arithmetic: how far through the flight are we, where is that on the path,
    which way does the path point there.

    `arr_ms` is the stabilised arrival the countdown already uses, so the aeroplane and the
    clock it is racing cannot disagree — a delay absorbed into the ETA slows the marker down
    here rather than teleporting it on arrival.

    Clamped at both ends. Before departure it waits at the gate rather than reversing down the
    corridor; after arrival it stays at the destination rather than continuing past it.

    Returns None when the inputs cannot support an answer, rather than guessing. A caller that
    gets None draws nothing, which is honest; a caller that gets a fabricated point cannot tell.
    """
    if not path:
        return None
    for v in (dep_ms, arr_ms, now_ms):
        if v is None or not math.isfinite(v):
            return None
    if arr_ms <= dep_ms:
        return None

    f = (now_ms - dep_ms) / (arr_ms - dep_ms)
    f = min(1.0, max(0.0, f))

    point = interpolate_path(path, f)
    if point is None:
        return None
    return {"lat": point[0], "lon": point[1],
            "track_deg": bearing_from_path(path, f),
            "fraction": f}


def within_projection_window(arr_ms: float | None, now_ms: float, linger_ms: float) -> bool:
    """
    Is it still honest to draw this aeroplane?

    A projection has no way to know a flight has landed — it only knows the schedule ran out. So
    a flight past its arrival with nothing recorded pins at the destination and stays there,
    which is how the website ended up with arrived markers that never expire on its schedule
    overlay. The same rule in a new place would be the same defect.

    After the window closes the flight simply has no position, and a client that is given no
    position draws nothing. That is the honest answer: we do not know where it is, and it is
    almost certainly on the ground.

    An unknown arrival keeps the flight, rather than dropping it — the schedule is the thing in
    doubt there, not the aeroplane.
    """
    if arr_ms is None or not math.isfinite(arr_ms):
        return True
    return now_ms <= arr_ms + linger_ms

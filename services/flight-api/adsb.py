"""
Direct reception, swept here instead of read from a table a minute later.

The circles are the best data this project has — 2 to 4 seconds old at the source, and for about
a third of the traffic the only thing that can see the aircraft at all. Until now this service
consumed them through `aircraft_last_seen`, which a cron writes roughly once a minute, so our
freshest source arrived through the slowest path in the system.

Measured 17 Aug against production, which sweeps the aggregators itself: our fixes were 58
seconds older on five of six flights in one round, while FYC762 sat at age 0 on the website every
single round and swung 71s → 3s → 7s here. FR24-sourced flights matched to the second, because
both sides read the same rows — the divergence was confined to the source we were throttling.

SWEPT IN THE BACKGROUND, NOT ON THE REQUEST PATH. A full sweep takes about seven seconds: six
circles, sequentially, with a gap between them because adsb.fi's public limit is roughly one
request a second and firing them together earns a 429 on most. Doing that inside a request would
trade a stale document for a slow one. A loop keeps memory warm and every request reads memory.

The circle list, the provider fallback and the Syria-first merge order are the website's,
deliberately unchanged: it has been tuned against real coverage and there is nothing to gain from
a second opinion about where the circles should sit.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

import httpx

from geo import is_plausible_fix, drop_sentinel_fixes

# Syria first — on an aircraft two circles can both see, the home circle's fix wins.
CIRCLES: list[list[str]] = [
    [  # Syria
        "https://opendata.adsb.fi/api/v3/lat/33.41/lon/36.52/dist/250",
        "https://api.adsb.lol/v2/lat/33.41/lon/36.52/dist/250",
    ],
    [  # UAE
        "https://opendata.adsb.fi/api/v3/lat/25.0/lon/55.0/dist/250",
        "https://api.adsb.lol/v2/lat/25.0/lon/55.0/dist/250",
    ],
    [  # Turkey / Istanbul
        "https://opendata.adsb.fi/api/v3/lat/41.0/lon/29.0/dist/250",
        "https://api.adsb.lol/v2/lat/41.0/lon/29.0/dist/250",
    ],
    [  # Anatolia
        "https://opendata.adsb.fi/api/v3/lat/38.0/lon/33.5/dist/250",
        "https://api.adsb.lol/v2/lat/38.0/lon/33.5/dist/250",
    ],
    [  # Arabia
        "https://opendata.adsb.fi/api/v3/lat/27.1/lon/47.3/dist/250",
        "https://api.adsb.lol/v2/lat/27.1/lon/47.3/dist/250",
    ],
    [  # Europe
        "https://opendata.adsb.fi/api/v3/lat/52.34/lon/9.13/dist/250",
        "https://api.adsb.lol/v2/lat/52.34/lon/9.13/dist/250",
    ],
]

CIRCLE_GAP_S = 1.1        # adsb.fi allows about one request a second
FETCH_TIMEOUT_S = 8.0
SWEEP_PAUSE_S = 4.0       # between sweeps; with ~7s of sweeping that is a ~11s cycle

# What the sweeper knows, read by every request. Written only by the loop below.
_positions: dict[str, dict] = {}
_state: dict = {"last_sweep_at": None, "circles_ok": 0, "aircraft": 0, "sweeps": 0, "failures": 0}


def state() -> dict:
    """A copy, so a caller cannot edit the sweeper's own record by accident."""
    return dict(_state)


async def _fetch_circle(client: httpx.AsyncClient, urls: list[str]) -> tuple[bool, list[dict]]:
    """
    One circle, trying each provider in turn.

    An empty answer and no answer are different facts and every caller needs to tell them apart:
    one means quiet airspace, the other means we are blind. Collapsing both to [] is what stopped
    the website's database fallback ever firing — the map simply cleared.
    """
    for url in urls:
        try:
            r = await client.get(url, headers={"User-Agent": "FlySyria/1.0"},
                                 timeout=FETCH_TIMEOUT_S)
            if r.status_code != 200:
                continue
            ac = (r.json() or {}).get("ac") or []
            return True, [a for a in ac if a.get("lat") is not None and a.get("lon") is not None]
        except Exception:
            continue                              # try the next provider
    return False, []


async def sweep(client: httpx.AsyncClient) -> dict[str, dict]:
    """
    One pass of every circle, sequentially. Returns positions keyed by callsign.

    Guarded before anything is stored, and guarded HERE rather than at read time so a corrupt
    sweep never enters memory at all. On 15–16 Aug the aggregator served 47 aircraft stamped on
    Queen Alia airport with gs 0.7 while their altitudes stayed real; on the 16th it put two
    flights on Dubai International with track 0.
    """
    results: list[tuple[bool, list[dict]]] = []
    for i, urls in enumerate(CIRCLES):
        if i:
            await asyncio.sleep(CIRCLE_GAP_S)
        results.append(await _fetch_circle(client, urls))

    circles_ok = sum(1 for ok, _ in results if ok)

    seen_hex: set[str] = set()
    merged: list[dict] = []
    for _, aircraft in results:                    # Syria first, by list order
        for a in aircraft:
            hexid = a.get("hex")
            if not hexid or hexid in seen_hex:
                continue
            seen_hex.add(hexid)
            merged.append(a)

    merged = drop_sentinel_fixes([a for a in merged if is_plausible_fix(a)], key="hex")

    # `seen` is seconds since the receiver last heard it, which is the only age the feed gives.
    now = datetime.now(timezone.utc)
    out: dict[str, dict] = {}
    for a in merged:
        cs = (a.get("flight") or "").strip().upper()
        if not cs:
            continue                              # identity comes from the board, never the fix
        age = a.get("seen")
        fix_at = now.timestamp() - (age if isinstance(age, (int, float)) else 0)

        # The aggregators encode "on the ground" as the STRING "ground" in alt_baro rather than
        # as a flag. Passing that straight through would put a string in altitude_ft and, worse,
        # leave on_ground unknown for precisely the aircraft that are telling us plainly — which
        # is the field derive_phase now leans on to call a departure before FR24 does.
        raw_alt = a.get("alt_baro")
        grounded = raw_alt == "ground"
        alt = 0 if grounded else (raw_alt if isinstance(raw_alt, (int, float)) else None)

        out[cs] = {
            "lat": a.get("lat"), "lon": a.get("lon"),
            "altitude_ft": alt,
            "ground_speed_kts": a.get("gs"),
            "track_deg": a.get("track"),
            "vertical_speed_fpm": a.get("baro_rate"),
            # True when it says so, False when it gives a real altitude, None when we cannot tell.
            # An explicit False is evidence; silence is not.
            "on_ground": True if grounded else (False if isinstance(alt, (int, float)) else None),
            "fix_at": datetime.fromtimestamp(fix_at, timezone.utc).isoformat(),
            "source": "adsb",
        }
    _state.update(circles_ok=circles_ok, aircraft=len(out), last_sweep_at=now.isoformat())
    return out


def positions() -> dict[str, dict]:
    """What the last completed sweep saw. Empty until the first one finishes."""
    return _positions


async def run_sweeper() -> None:
    """
    Keep memory warm for the life of the process.

    Never exits: a sweeper that dies on one bad night of upstream errors would silently return
    this service to the slow path, and the symptom — positions quietly a minute old — is exactly
    the one that took a measurement to notice in the first place.
    """
    async with httpx.AsyncClient() as client:
        while True:
            try:
                fresh = await sweep(client)
                if fresh:
                    _positions.clear()
                    _positions.update(fresh)
                _state["sweeps"] += 1
            except Exception:
                _state["failures"] += 1
            await asyncio.sleep(SWEEP_PAUSE_S)

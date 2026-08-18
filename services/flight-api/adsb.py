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
#
# Each circle costs about 1.1 s of the sweep, because adsb.fi allows roughly one request a
# second. Seven circles is ~8 s of sweeping on a ~12 s cycle, which is the ceiling before the
# document starts going stale between passes.
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
    [  # Moscow
        #
        # Added 17 Aug after a Syrian trial flight to Moscow that neither surface could see. It
        # was outside every circle — Moscow is about 1,800 km from the Hannover one — and an
        # unscheduled flight is not in FR24's filed schedule either, so we were blind twice over.
        # Centred between Sheremetyevo, Vnukovo, Domodedovo and Zhukovsky; 250 nm covers all four
        # and a long way down the approach from the south.
        "https://opendata.adsb.fi/api/v3/lat/55.75/lon/37.60/dist/250",
        "https://api.adsb.lol/v2/lat/55.75/lon/37.60/dist/250",
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

    now = datetime.now(timezone.utc)
    out: dict[str, dict] = {}
    for a in merged:
        cs = (a.get("flight") or "").strip().upper()
        if not cs:
            continue                              # identity comes from the board, never the fix
        out[cs] = to_position(a, _positions.get(cs), now)

    _state.update(circles_ok=circles_ok, aircraft=len(out), last_sweep_at=now.isoformat())
    return out


def to_position(a: dict, prev: dict | None, now: datetime) -> dict:
    """
    One aggregator record in the shape the rest of the service reads. Pure, so it can be tested
    without a network.

    `prev` is the last position we held for this callsign, used only to fill in fields the new
    record omits — never to override anything it does tell us.
    """
    # seen_pos, not seen. They are different ages and using the wrong one is a real bug: `seen`
    # is how long since the last MESSAGE, `seen_pos` how long since the last POSITION. An
    # aircraft still transmitting whose coordinate has not moved gets stamped as current while
    # its position is up to half a minute old — measured across the Syria circle, median
    # difference 0.2s but ABY265 at 33.2s.
    #
    # That is what made a marker sit still and then leap. ABY433 moved 0.0 km in 52 seconds and
    # then 22.8 km in 26; FYC486 froze mid-turn and covered 54.1 km in one step. The gap was
    # always real — stamping a stale coordinate as fresh is what hid it and then delivered it
    # all at once.
    age = a.get("seen_pos")
    if not isinstance(age, (int, float)):
        age = a.get("seen")
    if not isinstance(age, (int, float)):
        age = 0

    # The aggregators encode "on the ground" as the STRING "ground" in alt_baro rather than as a
    # flag. Passed straight through it would put a string in altitude_ft and, worse, leave
    # on_ground unknown for exactly the aircraft telling us plainly — which is the field
    # derive_phase leans on to call a departure before FR24 does.
    raw_alt = a.get("alt_baro")
    numeric_alt = raw_alt if isinstance(raw_alt, (int, float)) and not isinstance(raw_alt, bool) else None
    # Zero feet is the ground, whichever way the feed spells it.
    #
    # The aggregators usually send the STRING "ground", but not always — and a numeric 0 was
    # being mapped to on_ground False, which says the opposite of what the record means. No
    # aircraft in this network reports 0 ft pressure altitude while flying; at or below zero it
    # is on a runway or a stand.
    #
    # `<= 0` rather than `== 0` because pressure altitude is referenced to 1013 hPa and reads
    # slightly negative at a sea-level airport in high pressure. Those are parked aeroplanes too.
    grounded = raw_alt == "ground" or (numeric_alt is not None and numeric_alt <= 0)
    alt = 0 if raw_alt == "ground" else numeric_alt

    # An aeroplane doing 490 knots on 091 nineteen seconds ago is still doing roughly that. 12
    # of 48 aircraft in the Syria circle carry a position with no gs or no track at any moment,
    # and drawing that as stationary pointing north asserts something we have no reason to
    # believe: FYC486 was screenshotted mid-turn reading "track –, gs – kt" with the nose due
    # north, because the renderer defaults a missing track to zero.
    prev = prev or {}
    gs = a.get("gs")
    track = a.get("track")
    carried = []
    if gs is None:
        gs = prev.get("ground_speed_kts")
        carried.append("gs")
    if track is None:
        track = prev.get("track_deg")
        carried.append("track")

    return {
        "lat": a.get("lat"), "lon": a.get("lon"),
        "altitude_ft": alt,
        "ground_speed_kts": gs,
        "track_deg": track,
        "vertical_speed_fpm": a.get("baro_rate"),
        # True when it says so, False when it gives a real altitude, None when we cannot tell.
        # An explicit False is evidence; silence is not.
        "on_ground": True if grounded else (False if isinstance(alt, (int, float)) else None),
        "fix_at": datetime.fromtimestamp(now.timestamp() - age, timezone.utc).isoformat(),
        "source": "adsb",
        # So a reader can tell a reported value from a remembered one.
        "carried": carried or None,
    }


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

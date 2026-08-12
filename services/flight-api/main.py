#!/usr/bin/env python3
"""
Flight API v2 — the two documents the mobile app subscribes to.

Why this is a separate service
------------------------------
The constraint is that nothing we build touches the web today. The mobile app has no Supabase
client — everything it fetches goes through https://www.flysyria.app — so serving it new fields
from the Next.js app would mean deploying the web app. Additive routes nobody calls are low risk,
not zero risk, and zero was the requirement.

So this runs beside the harvester on Railway, reads the same database, and the web is never
redeployed. When the shape is validated the derivation lifts into Next.js routes unchanged.

What it serves
--------------
Two documents, split by rate of change rather than by subject:

    GET /v2/board?date=YYYY-MM-DD   schedule and slow facts       (~60s)
    GET /v2/live                    position and everything derived from it   (~30s)

The split matters. Putting `phase` in the board document while `position` ships separately would
leave a client holding a phase from 60 seconds ago beside a position from 5 seconds ago — two
snapshots, and the disagreement this whole exercise exists to remove would be back. Source and
derivation travel together, under one `as_of`.

The organising rule: **anything a user can see is computed here, once.** On 12 Aug the card, the
marker and the popup disagreed because three places each derived their own answer from data
fetched at three different times. No surface should calculate anything a reader looks at.
"""

from __future__ import annotations

import math
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

SB_URL = os.environ["SUPABASE_URL"].rstrip("/")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ["SUPABASE_ANON_KEY"]
SB_HEADERS = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

# Damascus is UTC+3 year round — the same assumption syriaDate() makes in both apps.
TZ = timezone(timedelta(hours=3))

# A live fix older than this is not describing where the aircraft is now. At a 60-second sweep a
# healthy fix is under two minutes old; beyond five it has either left the collection box or the
# feed has stopped carrying it, and a stale position is worse than none because the phase derived
# from it would still read as confident.
FIX_STALE_SEC = 300

# Concurrent readers share one database read. This is the publish model in miniature: the cost of
# a poll is paid once per interval, not once per subscriber, which is the same inversion the
# harvester applied upstream.
BOARD_TTL = 20
LIVE_TTL = 10

app = FastAPI(title="FlySyria flight API v2")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"],
)

_cache: dict[str, tuple[float, Any]] = {}
_airports: dict[str, tuple[float, float]] = {}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def sb(client: httpx.AsyncClient, path: str) -> list[dict]:
    r = await client.get(f"{SB_URL}/rest/v1/{path}", headers=SB_HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


async def airports(client: httpx.AsyncClient) -> dict[str, tuple[float, float]]:
    """Airport coordinates, loaded once. 55 rows, all with lat/lon."""
    if not _airports:
        for a in await sb(client, "airports?select=iata,lat,lon&lat=not.is.null"):
            _airports[a["iata"]] = (a["lat"], a["lon"])
    return _airports


def iso(v: str | None) -> datetime | None:
    return datetime.fromisoformat(v.replace("Z", "+00:00")) if v else None


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle km. Used for progress, not for navigation."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


# ── Derivation ───────────────────────────────────────────────────────────────

def derive_phase(f: dict, pos: dict | None) -> str:
    """
    The phase vocabulary, agreed 12 Aug.

    The governing rule is that a phase never claims more than the position supports. The three
    fine-grained states — taxiing, taxi_to_gate, at_gate — are emitted only when a live fix
    confirms them; without one the flight stays at the coarser departed / en_route / landed. The
    user never reads the words "estimated" or "untracked"; the state simply gets less specific,
    which reads as normal rather than as a caveat.

    That is what prevents the failure we named: a marker projected over Jordan while the card
    reads "Taxi to gate". Phase and position derive from the same fix, so they cannot disagree.
    """
    if (f.get("outcome") or "") == "cancelled":
        return "cancelled"

    on_ground = bool(pos and pos.get("on_ground"))
    moving = bool(pos and (pos.get("ground_speed_kts") or 0) > 3)

    if f.get("real_arr"):
        # Belt first: it is the last thing to arrive and the thing a person waiting cares about.
        # VF341 got CAR4 twenty minutes after landing, so arrival is not the end of the story.
        if f.get("arr_baggage"):
            return "bags_on_belt"
        if on_ground:
            return "taxi_to_gate" if moving else "at_gate"
        return "landed"

    if f.get("real_dep"):
        # `en_route` is the claim a live fix supports; `departed` is what we say when we know it
        # left and nothing more.
        return "en_route" if pos else "departed"

    if on_ground and moving:
        return "taxiing"
    return "scheduled"


def derive_progress(f: dict, pos: dict | None, aps: dict) -> tuple[float | None, str]:
    """
    Fraction of the journey, and how we got it.

    Always published — the bar must never freeze. With a live fix it is measured from the
    aircraft's actual position; without one it is elapsed time against block time. Both are
    honest answers to "roughly how far along is it", which is all a progress bar claims.

    `position` is the opposite: published only when a fix exists. A bar saying *about halfway* is
    supportable by a clock; a marker saying *the aircraft is at this point on the earth* is not,
    and pretending otherwise is what drew FYC728 over Jordan while it was 110 km east of Damascus.
    """
    dep, arr = aps.get(f.get("dep_iata")), aps.get(f.get("arr_iata"))

    if pos and dep and arr and not pos.get("on_ground"):
        here = (pos["lat"], pos["lon"])
        flown, remaining = haversine(dep, here), haversine(here, arr)
        if flown + remaining > 0:
            return round(min(max(flown / (flown + remaining), 0.0), 1.0), 4), "fix"

    real_dep, sched_dep = iso(f.get("real_dep")), iso(f.get("sched_dep"))
    sched_arr, est_arr = iso(f.get("sched_arr")), iso(f.get("est_arr"))
    start = real_dep or sched_dep
    end = est_arr or sched_arr
    if not start or not end or end <= start:
        return (1.0 if f.get("real_arr") else None), "clock"
    if f.get("real_arr"):
        return 1.0, "clock"
    if not f.get("real_dep"):
        return 0.0, "clock"
    frac = (datetime.now(timezone.utc) - start).total_seconds() / (end - start).total_seconds()
    return round(min(max(frac, 0.0), 1.0), 4), "clock"


def derive_eta(f: dict) -> tuple[str | None, str]:
    if f.get("real_arr"):
        return f["real_arr"], "feed"
    if f.get("est_arr"):
        return f["est_arr"], "feed"
    return f.get("sched_arr"), "schedule"


def derive_delay(f: dict) -> tuple[int | None, str | None]:
    """
    The second axis. On the ground, late is a state — past the slot, not yet departed. Airborne,
    late is a number — revised arrival against schedule.

    FR24 conflates these, applying "Delayed" to aircraft flying perfectly normally, and we should
    not copy that. XH491 on 12 Aug is why both ends are needed: it departed 24 minutes late and
    arrived 7 seconds early. One field has to pick one and misrepresent the other.
    """
    sched_dep, sched_arr = iso(f.get("sched_dep")), iso(f.get("sched_arr"))
    real_dep = iso(f.get("real_dep"))

    if not real_dep:
        if not sched_dep:
            return None, None
        ref = iso(f.get("est_dep")) or datetime.now(timezone.utc)
        mins = round((ref - sched_dep).total_seconds() / 60)
        return (mins if mins > 0 else 0), "departure"

    end = iso(f.get("real_arr")) or iso(f.get("est_arr"))
    if end and sched_arr:
        return round((end - sched_arr).total_seconds() / 60), "arrival"
    return round((real_dep - sched_dep).total_seconds() / 60) if sched_dep else None, "departure"


def dep_confirmed(f: dict, pos: dict | None) -> bool:
    """
    Departure times get revised; arrival times do not. Measured over 17.5 hours: real_dep was
    corrected on 22 of 182 legs (12.1%), real_arr on 0 of 163. Of the 22 corrections, 20 began as
    a round minute and all 22 ended with precise seconds.

    A round minute is not by itself proof — 4 values stayed round for 36-50 hours and were never
    corrected — so a position showing the aircraft airborne settles it independently.
    """
    d = iso(f.get("real_dep"))
    if not d:
        return False
    if d.second != 0:
        return True
    return bool(pos and not pos.get("on_ground"))


# ── Documents ────────────────────────────────────────────────────────────────

async def latest_positions(client: httpx.AsyncClient) -> dict[str, dict]:
    """Newest fix per flight, discarding anything too old to describe the present."""
    # Percent-encoded: an ISO timestamp ends in "+00:00" and a bare + in a query string is a
    # space. PostgREST answered 400 on "2026-08-10T18:19:48 00:00" until the harvester quoted it.
    cutoff = quote(
        (datetime.now(timezone.utc) - timedelta(seconds=FIX_STALE_SEC)).isoformat(), safe="")
    rows = await sb(
        client,
        "fr24_live_position?select=fr24_id,fr24_row,lat,lon,altitude_ft,ground_speed_kts,"
        "track_deg,vertical_speed_fpm,on_ground,fix_at,source"
        f"&fix_at=gte.{cutoff}&order=fix_at.desc",
    )
    out: dict[str, dict] = {}
    for r in rows:
        out.setdefault(r["fr24_id"], r)      # ordered desc, so first wins
    return out


async def build_live() -> dict:
    async with httpx.AsyncClient() as client:
        aps = await airports(client)
        pos_by_id = await latest_positions(client)
        if not pos_by_id:
            return {"as_of": now_iso(), "flights": []}

        ids = ",".join(f'"{i}"' for i in pos_by_id)
        flights = await sb(client, f"flight?select=*&fr24_id=in.({ids})")

    out = []
    for f in flights:
        pos = pos_by_id.get(f.get("fr24_id"))
        progress, p_basis = derive_progress(f, pos, aps)
        eta, e_basis = derive_eta(f)
        delay, d_basis = derive_delay(f)
        out.append({
            "iata_number": f["iata_number"],
            "callsign": f.get("callsign"),
            "fr24_id": f.get("fr24_id"),
            "flight_date": f["flight_date"],
            "phase": derive_phase(f, pos),
            "progress": progress,
            "progress_basis": p_basis,
            "eta_utc": eta,
            "eta_basis": e_basis,
            "delay_min": delay,
            "delay_basis": d_basis,
            "position": {
                "lat": pos["lat"], "lon": pos["lon"],
                "altitude_ft": pos.get("altitude_ft"),
                "ground_speed_kts": pos.get("ground_speed_kts"),
                "track_deg": pos.get("track_deg"),
                "vertical_speed_fpm": pos.get("vertical_speed_fpm"),
                "on_ground": pos.get("on_ground"),
                "fix_at": pos.get("fix_at"),
                "source": pos.get("source"),
            } if pos else None,
        })
    return {"as_of": now_iso(), "flights": out}


async def build_board(date: str) -> dict:
    async with httpx.AsyncClient() as client:
        flights = await sb(client, f"flight?select=*&flight_date=eq.{date}&order=sched_dep.asc")
        pos_by_id = await latest_positions(client)

    out = []
    for f in flights:
        pos = pos_by_id.get(f.get("fr24_id"))
        dep_local = iso(f["sched_dep"]).astimezone(TZ).date()
        arr_local = iso(f["sched_arr"]).astimezone(TZ).date()
        out.append({
            **f,
            # The mirror of the existing arr_next_day, completing the two-board model: one flight
            # row, two appearances. A departure at 22:00 arriving 00:25 belongs on today's
            # departures board and tomorrow's arrivals board.
            "arr_next_day": arr_local > dep_local,
            "dep_prev_day": dep_local < arr_local,
            "dep_confirmed": dep_confirmed(f, pos),
        })
    return {"as_of": now_iso(), "date": date, "flights": out}


# ── Routes ───────────────────────────────────────────────────────────────────

async def cached(key: str, ttl: int, build):
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    doc = await build()
    _cache[key] = (time.monotonic(), doc)
    return doc


@app.get("/v2/live")
async def live():
    return await cached("live", LIVE_TTL, build_live)


@app.get("/v2/board")
async def board(date: str | None = Query(None)):
    day = date or datetime.now(TZ).strftime("%Y-%m-%d")
    return await cached(f"board:{day}", BOARD_TTL, lambda: build_board(day))


@app.get("/health")
async def health():
    return {"ok": True, "as_of": now_iso()}

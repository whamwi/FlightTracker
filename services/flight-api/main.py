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
# How much older our own ADS-B may be and still be preferred over FR24's feed. One harvester
# sweep is 60s, so a fix from the previous sweep still counts as current; anything older means
# our receivers have lost the aircraft and the feed is simply better informed.
ADSB_PREFER_TOLERANCE_SEC = 75

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
_airlines: dict[str, dict] = {}


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


async def airlines(client: httpx.AsyncClient) -> dict[str, dict]:
    """The curated allow-list, by IATA code. A carrier absent from it is not a flight we show."""
    if not _airlines:
        for a in await sb(client, "airlines?select=iata,icao,name_en,country_flag"):
            _airlines[a["iata"]] = a
    return _airlines


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



# ── The board contract ───────────────────────────────────────────────────────
#
# The 24 fields every client already reads, reproduced exactly rather than approximated. This is
# the shape scripts/contract_proof.py validated at 90 of 90 against production — the four
# apparent misses were a day-bucketing convention, not data.

STATUS_RANK = {"Scheduled": 1, "Estimated": 2, "Departed": 5, "Arrived": 8, "Cancelled": 9}


def zulu(v: str | None) -> str | None:
    """The board's timestamp form: milliseconds and a Z, not an offset."""
    d = iso(v)
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z") if d else None


def derive_status(f: dict) -> str:
    """
    Status is a rendering, not a stored fact.

    Measured across 28 flights seen from both ends: the timestamps agreed and the status strings
    disagreed 27 times, because each airport describes the flight from its own role. FR24's own
    text is worse still — 74 arrived flights were still reading "Departed" and 28 legs carried no
    status at all — which is why this is derived from the times instead.
    """
    if (f.get("outcome") or "") == "cancelled":
        return "Cancelled"
    if f.get("real_arr"):
        return "Arrived"
    dep, est_arr = iso(f.get("real_dep")), iso(f.get("est_arr"))
    if dep and est_arr:
        eff = (est_arr - dep).total_seconds() / 60
        # Down once actual departure plus effective block time is more than fifteen minutes past.
        if eff > 30 and dep + timedelta(minutes=eff) < datetime.now(timezone.utc) - timedelta(minutes=15):
            return "Arrived"
    if dep:
        return "Departed"
    # "Expected", not "Estimated" — production's vocabulary is Arrived / Departed / Expected /
    # Scheduled, and every client's dictionary keys off those four words.
    if f.get("est_dep") or f.get("est_arr"):
        return "Expected"
    return "Scheduled"


def effective_duration(f: dict) -> int:
    """Actual departure to revised arrival when both are known — the schedule is padded."""
    dep, est_arr = iso(f.get("real_dep")), iso(f.get("est_arr"))
    if dep and est_arr:
        computed = round((est_arr - dep).total_seconds() / 60)
        if computed > 30:
            return computed
    sd, sa = iso(f["sched_dep"]), iso(f["sched_arr"])
    return round((sa - sd).total_seconds() / 60)


def terminal(v: str | None) -> str | None:
    """FR24 sometimes prefixes a terminal with T; clients render the bare number."""
    v = (v or "").strip()
    if not v:
        return None
    return v[1:] if len(v) > 1 and v[0].upper() == "T" and v[1:].isalnum() else v


def to_contract(f: dict, al: dict | None, pos: dict | None, board_day) -> dict:
    sd, sa = iso(f["sched_dep"]), iso(f["sched_arr"])
    # Effective, not scheduled. XH524 was filed 22:30 -> 00:10 and actually landed 23:59, same
    # day: a +1 taken from the schedule contradicts the arrival time printed beside it.
    eff_dep = iso(f.get("real_dep")) or sd
    eff_arr = iso(f.get("real_arr")) or iso(f.get("est_arr")) or sa
    dep_local, arr_local = eff_dep.astimezone(TZ).date(), eff_arr.astimezone(TZ).date()
    return {
        # Both identifiers, always. FR24 files some carriers under one form and some the other.
        "iata_number":   f["iata_number"],
        "callsign":      f.get("callsign"),
        "airline_name":  (al or {}).get("name_en"),
        "airline_iata":  f.get("airline_iata") or (al or {}).get("iata"),
        "country_flag":  (al or {}).get("country_flag"),
        "dep_iata":      f["dep_iata"],
        "arr_iata":      f["arr_iata"],
        "dep_time_utc":  sd.astimezone(timezone.utc).strftime("%H:%M"),
        "arr_time_utc":  sa.astimezone(timezone.utc).strftime("%H:%M"),
        "sched_dep_unix": int(sd.timestamp()),
        "duration_min":  effective_duration(f),
        "status":        derive_status(f),
        "actual_dep_utc":  zulu(f.get("real_dep")),
        "actual_arr_utc":  zulu(f.get("real_arr")),
        "revised_dep_utc": zulu(f.get("est_dep")),
        "revised_arr_utc": zulu(f.get("est_arr")),
        "aircraft_type": f.get("aircraft_type"),
        "aircraft_reg":  f.get("registration") or "",
        "dep_terminal":  terminal(f.get("dep_terminal")),
        "dep_gate":      f.get("dep_gate"),
        "arr_terminal":  terminal(f.get("arr_terminal")),
        "arr_gate":      f.get("arr_gate"),
        # Suppressed until the flight is actually down. FR24 republishes belts from earlier
        # instances of the same number: FZ1114 carried 3, then 7, then 1 across a day, on a leg
        # that had not yet departed. A belt shown before arrival is not early information, it is
        # the wrong carousel.
        "arr_baggage":   f.get("arr_baggage") if f.get("real_arr") else None,
        # Both relative to the board being read, not to each other.
        #
        # They were `arr_local > dep_local` and `dep_local < arr_local` — the same condition, so
        # every midnight-crossing flight carried both flags on every board. On the 11th's board a
        # flight landing at 00:56 on the 12th is arr_next_day; on the 12th's board the same flight
        # is dep_prev_day. Never both.
        "arr_next_day":  arr_local > board_day,
        "dep_prev_day":  dep_local < board_day,
        "dep_confirmed": dep_confirmed(f, pos),
    }


# ── Documents ────────────────────────────────────────────────────────────────

async def latest_positions(client: httpx.AsyncClient) -> dict[str, dict]:
    """
    Newest fix per flight, discarding anything too old to describe the present.

    One table, both sources. Our own ADS-B is written into `fr24_live_position` by the harvester
    with source='adsb', beside FR24's feed rows, keyed by the same fr24_id — so this reads one
    place and nothing downstream has to know a second one exists. Joining two position tables at
    serve time, which this did briefly on 12 Aug, only moves the disagreement into the reader.
    """
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
    # Direct reception beats a network aggregate *of comparable age*, and only that.
    #
    # This preferred `source='adsb'` over recency unconditionally, which is wrong the moment the
    # two diverge in age: on 13 Aug it served five flights from ADS-B fixes four minutes old
    # while four-second-old feed rows sat unused. At 450 kts that is ~55 km of error, and when
    # the stale row finally crossed FIX_STALE_SEC the marker jumped to the feed position — a
    # visible lurch produced entirely by this preference.
    #
    # So the tolerance is the whole rule: take our own reception when it is within a sweep of the
    # freshest thing we have, and the newest fix otherwise. Preferring one source still stops a
    # flight both can see from jittering between them poll to poll, which is why the preference
    # exists at all.
    out: dict[str, dict] = {}
    for r in rows:                            # ordered desc, so first of a kind is the newest
        cur = out.get(r["fr24_id"])
        if cur is None:
            out[r["fr24_id"]] = r
            continue
        if cur.get("source") == "adsb" or r.get("source") != "adsb":
            continue                          # already ours, or this one is not
        newest, ours = iso(cur.get("fix_at")), iso(r.get("fix_at"))
        if newest and ours and (newest - ours).total_seconds() <= ADSB_PREFER_TOLERANCE_SEC:
            out[r["fr24_id"]] = r
    return out


async def build_live() -> dict:
    async with httpx.AsyncClient() as client:
        aps = await airports(client)
        pos_by_id = await latest_positions(client)

        # Everything with a fresh fix, whichever source produced it. A flight our own receivers
        # can see but FR24 has filed no live instance for is already here: the harvester wrote it
        # under the same fr24_id.
        flights: list[dict] = []
        if pos_by_id:
            ids = ",".join(f'"{i}"' for i in pos_by_id)
            flights = await sb(client, f"flight?select=*&fr24_id=in.({ids})")
        if not flights:
            return {"as_of": now_iso(), "flights": []}

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
            # Both actuals travel with the live document now, so a consumer never needs a second
            # source to know whether the flight is still flying.
            "actual_dep_utc": zulu(f.get("real_dep")),
            "actual_arr_utc": zulu(f.get("real_arr")),
            "dep_iata": f.get("dep_iata"),
            "arr_iata": f.get("arr_iata"),
            "duration_min": effective_duration(f),
        })
    return {"as_of": now_iso(), "flights": out}


async def build_board(date: str) -> dict:
    """
    A day's flights in the shape every client already reads.

    Selected on local departure day OR local arrival day, which is the two-board model: a flight
    leaving 22:00 and landing 00:25 belongs on today's departures board and tomorrow's arrivals
    board. One row, two appearances, each annotated so the reader knows which end sits on another
    day. Affects about 2.4% of flights.
    """
    async with httpx.AsyncClient() as client:
        # A day either side, then filtered on local dates — cheaper than a computed-column query
        # and it keeps the timezone rule in one place rather than in SQL as well.
        rows = await sb(
            client,
            f"flight?select=*&flight_date=gte.{date}&flight_date=lte.{date}"
            f"&order=sched_dep.asc",
        )
        span = await sb(
            client,
            f"flight?select=*&flight_date=eq.{(datetime.strptime(date, '%Y-%m-%d') - timedelta(days=1)).strftime('%Y-%m-%d')}"
            f"&order=sched_dep.asc",
        )
        als = await airlines(client)
        pos_by_id = await latest_positions(client)

    want = datetime.strptime(date, "%Y-%m-%d").date()
    out = []
    for f in [*rows, *span]:
        sd, sa = iso(f["sched_dep"]), iso(f["sched_arr"])
        if not sd or not sa:
            continue
        # Selected on the days the flight ACTUALLY used, not the ones it was filed for — the same
        # basis the +1/-1 flags use, or the two contradict each other. XH524 was filed
        # 22:30 -> 00:10 and landed at 23:59: it belongs to the 11th alone, and picking it for
        # the 12th put a completed flight on the wrong day's arrivals.
        eff_dep = iso(f.get("real_dep")) or sd
        eff_arr = iso(f.get("real_arr")) or iso(f.get("est_arr")) or sa
        dep_local, arr_local = eff_dep.astimezone(TZ).date(), eff_arr.astimezone(TZ).date()
        if dep_local != want and arr_local != want:
            continue
        al = als.get(f.get("airline_iata") or "")
        out.append(to_contract(f, al, pos_by_id.get(f.get("fr24_id")), want))

    out.sort(key=lambda x: x["sched_dep_unix"])
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

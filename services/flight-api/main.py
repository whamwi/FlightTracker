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

import asyncio
import math
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import adsb
from geo import (
    is_plausible_fix,
    drop_sentinel_fixes,
    fix_contradicts_flight,
    great_circle_path,
    project_position,
    within_projection_window,
)

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
# How long a landed flight stays in the live document after touchdown. See build_live: the ground
# phases only exist for a flight that has stopped moving, which is exactly when FIX_STALE_SEC has
# already dropped it.
#
# Thirty minutes, matching ARRIVED_HOLD_MS on the web and ARRIVED_HOLD_MIN in the mobile app. It
# was an hour here while the app used thirty, so the same flight left one surface half an hour
# before the other — and this document is what the phase chip reads, so the two disagreed on
# screen at once.
ARRIVED_LINGER_SEC = 1800
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


@app.on_event("startup")
async def _start_sweeper() -> None:
    """
    One background sweep loop for the life of the process.

    Deliberately fire-and-forget: if it could not start, every request still falls back to
    aircraft_last_seen and the service is merely as slow as it was yesterday, which is a far
    better failure than refusing to boot.
    """
    asyncio.create_task(adsb.run_sweeper())
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


_route_paths: dict[str, list[dict]] = {}


async def route_paths(client: httpx.AsyncClient) -> dict[str, list[dict]]:
    """
    Recorded corridors, keyed by OD pair.

    Collapsed to one path per pair by observed_count, the same rule /api/routes applies — a
    second variant silently overwriting the first is a bug that endpoint already found.

    Cached for the process lifetime like airports and airlines: these change when someone
    imports a route, not between polls.
    """
    if _route_paths:
        return _route_paths
    rows = await sb(
        client,
        "route_paths?select=dep_iata,arr_iata,waypoints,observed_count"
        "&order=observed_count.desc,variant.asc",
    )
    for r in rows:
        od = f"{r.get('dep_iata')}|{r.get('arr_iata')}"
        wps = r.get("waypoints")
        if od not in _route_paths and isinstance(wps, list) and wps:
            _route_paths[od] = wps
    return _route_paths


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
    outcome = f.get("outcome") or ""
    if outcome == "cancelled":
        return "cancelled"
    # Deliberately a phase this build's clients do not know. PhaseChip renders nothing for an
    # unrecognised key and the caller falls back to the status badge, which says Diverted — the
    # fallback that exists so the server can introduce a state without a client deploy. Better a
    # correct word from the older path than a confident wrong one from the newer.
    if outcome == "diverted":
        return "diverted"

    on_ground = bool(pos and pos.get("on_ground"))
    moving = bool(pos and (pos.get("ground_speed_kts") or 0) > 3)

    confirmed = bool(f.get("real_arr") or f.get("arr_confirmed_at"))

    # ── The ground, in the order a person waiting actually experiences it ─────
    #
    # Four stages, not one word. Someone meeting a flight wants to know the difference between
    # "it has touched down", "it is coming in", "it is on stand" and "that is the end of it",
    # and all four are visible in the fix: altitude says it is down, ground speed says which of
    # the three it is doing.
    #
    #   landed        wheels down, still rolling out       gs >= 50
    #   taxi_to_gate  crossing the airfield                3 < gs < 50
    #   at_gate       stopped, nobody has confirmed yet    gs <= 3
    #   arrived       stopped AND FR24 has the landing     gs <= 3, terminal
    #
    # 50 knots is the same number the departure rule uses for "moving faster than any taxi", so
    # rollout and taxi divide on a boundary the file already trusts rather than a new one.
    #
    # `arrived` is deliberately the only state that requires the published signal. Everything
    # before it is something we watched happen; ending the flight's life is a claim about a
    # record, and that record is FR24's. RJA431 into Aleppo on 17 Aug is the case: on the ground
    # for five minutes reading `departed`, because every branch here waited for a signal that
    # had not come. Now it reads landed, then taxi_to_gate, then at_gate, and only becomes
    # arrived when 02:24:16 lands.
    # Only on the way IN. Without this gate the ladder catches an aircraft that has not left
    # yet — a departure parked at its stand would read at_gate, and one taxiing out would read
    # taxi_to_gate, which is the right words for the wrong half of the trip.
    if on_ground and (confirmed or f.get("real_dep")):
        gs = (pos or {}).get("ground_speed_kts") or 0
        if gs >= 50:
            return "landed"
        if gs > 3:
            return "taxi_to_gate"
        # Belt beats at_gate but not arrival: it is the last thing to be published and the thing
        # a person waiting actually came for. VF341 got CAR4 twenty minutes after landing.
        if f.get("arr_baggage"):
            return "bags_on_belt"
        return "arrived" if confirmed else "at_gate"

    if confirmed:
        # Confirmed down with no position to say more. The coarser word, as ever.
        if f.get("arr_baggage"):
            return "bags_on_belt"
        return "arrived"

    if f.get("real_dep"):
        # `en_route` is the claim a live fix supports; `departed` is what we say when we know it
        # left and nothing more.
        return "en_route" if pos else "departed"

    if on_ground and moving:
        return "taxiing"

    # Departed, whatever FR24 has published.
    #
    # Every branch above waits for real_dep, so an aircraft we can SEE flying was called
    # "scheduled" until FR24 got round to filing a departure. FDB1192 ALP-DXB on 16 Aug was
    # reported scheduled while climbing through 25,900 ft at 425 knots — its own progress field
    # already read 7% with an ETA of 15:13, so the document contradicted itself.
    #
    # THE FLAG DOES THE WORK, NOT THE ALTITUDE. This began at 5,000 ft, chosen so a parked
    # aircraft reporting field elevation could never be promoted — AMM is 2,395 ft, RUH 2,082.
    # That floor was too blunt: FYC762 SHJ-ALP on 17 Aug climbed out at 1,125 ft and 182 knots
    # with `on_ground: false` on every fix from two independent sources, and read scheduled for
    # 55 seconds until FR24's departure arrived at 01:50:00. Over 24 hours, 825 fixes are
    # explicitly airborne below 5,000 ft, and the flag is present on 99.8% of them.
    #
    # So an explicit false is believed at any height, and 250 ft is only the fallback for the
    # 0.2% that omit the flag — high enough above a runway to mean something, low enough to
    # catch a departure as it rotates.
    #
    # `is not True` guards all of it: a fix that says it is ON the ground is never promoted,
    # however fast. That is the take-off roll — 16 fixes in 24 hours — and it keeps reading
    # taxiing for a few more seconds, which is the safe direction to be wrong in.
    if (pos and pos.get("on_ground") is not True
            and (pos.get("ground_speed_kts") or 0) >= 50
            and (pos.get("on_ground") is False or (pos.get("altitude_ft") or 0) >= 250)):
        return "en_route"

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


ETA_WOBBLE_MIN = 3
"""Wider than the observed wobble, far narrower than any real schedule change."""

# Last ETA published for a flight, so a bounce between two values is not shown as a change.
# Process-local by design — see stable_eta.
_ETA_HELD: dict[tuple, str] = {}


def eta_key(f: dict) -> tuple:
    """A flight's identity for the day. The same key the live document dedupes on."""
    return (f.get("flight_date"), f.get("iata_number"), f.get("dep_iata"), f.get("arr_iata"))


def hold_eta(key: tuple, raw: str | None, held: dict[tuple, str]) -> str | None:
    """
    The published estimate, held steady against wobble. Pure, so it can be tested.

    The countdown a reader watches is arrival-minus-now, so every revision FR24 publishes moves
    it — and it revises constantly, often back to a value it has already held. RB515 on 12 Aug
    bounced between exactly two estimates five times in forty minutes:

        12:28  13:22:08
        12:29  13:24:16   +2.1
        12:50  13:22:08   -2.1
        12:52  13:24:16   +2.1
        12:58  13:22:08   -2.1
        12:59  13:24:16   +2.1

    A reader sees "16m left" become "23m left" and back. Two devices polling thirty seconds
    apart legitimately show numbers seven minutes apart, each correct for the estimate it holds.

    So a new estimate is adopted only when it differs by more than the wobble. A genuine delay
    still arrives — it moves far more than three minutes — while a bounce nobody chose to publish
    twice does not reach any screen.

    This lived in the mobile app and only there, so the app damped and the site did not: measured
    15 Aug on SDR17HL, the site read "3:42 left" and the phone "3 hours 39 minutes" at the same
    moment. Damping in each client is damping in none — the whole point is that every surface
    shows one number, and a rule that must hold across surfaces belongs to the answer rather than
    to whoever is rendering it.
    """
    if raw is None:
        held.pop(key, None)
        return None
    prev = held.get(key)
    if prev is None:
        held[key] = raw
        return raw
    a, b = iso(raw), iso(prev)
    if a is None or b is None or abs((a - b).total_seconds()) >= ETA_WOBBLE_MIN * 60:
        held[key] = raw
        return raw
    return prev


def stable_eta(f: dict, raw: str | None) -> str | None:
    """
    hold_eta against process-local state, pruned to the current day.

    Process-local rather than a column, deliberately: every reader of this service shares one
    process, so they cannot disagree with each other, which is the property being bought. It
    re-anchors on redeploy — harmless, since re-anchoring means adopting the current estimate,
    which is what would have been shown anyway — and it assumes a single instance. If this ever
    runs replicated, two readers could hold different anchors and this must move to the row.
    """
    key = eta_key(f)
    out = hold_eta(key, raw, _ETA_HELD)
    if len(_ETA_HELD) > 4000:
        today = datetime.now(TZ).strftime("%Y-%m-%d")
        for k in [k for k in _ETA_HELD if k[0] != today]:
            _ETA_HELD.pop(k, None)
    return out


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
    outcome = f.get("outcome") or ""
    if outcome == "cancelled":
        return "Cancelled"
    # Diverted outranks Arrived, and that is the point of it.
    #
    # A diverted flight often does land, and FR24 may publish a real_arr for it — at the airport
    # it went to, not the one on the ticket. Returning "Arrived" there would be true about the
    # aircraft and false about the journey. The web map also ACTS on this word rather than only
    # displaying it: boardDeparted drops diverted flights so the predictor stops carrying them
    # toward a destination they have already turned away from. G9375 was drawn heading for
    # Damascus while it was over Jordan bound for Amman.
    #
    # Untested against live data — there is no diversion in the retained tape.
    if outcome == "diverted":
        return "Diverted"
    if f.get("real_arr"):
        return "Arrived"
    # An arrival we established when FR24 did not — landing-confirm writes it, and it is kept in
    # its own column precisely so real_arr can supersede it the moment FR24 publishes one. FR24
    # is silent on 22 of 35 Aleppo arrivals; without this, half that board never finishes.
    if f.get("arr_confirmed_at"):
        return "Arrived"
    dep, est_arr = iso(f.get("real_dep")), iso(f.get("est_arr"))
    if dep and est_arr:
        # Five minutes past the estimate, not fifteen.
        #
        # est_arr is a live figure: FR24 revises it while the aircraft flies, so a flight that
        # holds or runs long already has a later estimate. Padding it by a quarter of an hour was
        # protecting against something the estimate had itself accounted for.
        #
        # FAD742 on 14 Aug: departed 08:21:04, estimate 10:13:14, descending through 12,575 ft
        # 45 km from Jeddah at 10:00, so down around 10:07. The old rule declared it arrived at
        # 10:28 — twenty-one minutes after the fact. Five minutes puts that at 10:18.
        #
        # Not zero: the estimate freezes when a track dies, and measured at that moment it runs
        # early — 0.7 min at Damascus, 5.7 at Aleppo where coverage ends far out. Five absorbs
        # Damascus comfortably and most of Aleppo.
        if est_arr < datetime.now(timezone.utc) - timedelta(minutes=5):
            return "Arrived"
    if dep:
        return "Departed"
    # "Expected", not "Estimated" — production's vocabulary is Arrived / Departed / Expected /
    # Scheduled, and every client's dictionary keys off those four words.
    if revision(f.get("est_dep"), f.get("sched_dep")) or revision(f.get("est_arr"), f.get("sched_arr")):
        return "Expected"
    return "Scheduled"


def revision(est: str | None, sched: str | None) -> str | None:
    """
    An estimate only counts when it says something the schedule does not.

    FR24 publishes `est_dep` equal to the filed time and keeps it there — FZ1115 carried
    est_dep 02:50 against sched_dep 02:50 for eleven hours on 13 Aug, then dropped it. Reading
    the mere presence of the field as "there is an estimate" made us call the flight Expected
    while FR24's own board said Scheduled, and put a `revised_dep_utc` in the contract that
    revised nothing.

    Strictly more than a minute, not at least: the same flight's tape carries est_dep 02:51
    against sched 02:50 one sweep later. A minute either way is FR24 rounding, and a status that
    flips on it would flicker between Scheduled and Expected while nothing changed.
    """
    e, s_ = iso(est), iso(sched)
    if e is None or s_ is None:
        return est
    return est if abs((e - s_).total_seconds()) > 60 else None


# Below this, a computed block is not a short flight, it is a corrupt estimate.
#
# Was 30, which is longer than a real sector we fly. DAM-AMM is filed at 50 minutes and flown in
# 28, so the floor rejected the truth and substituted the padded schedule — and the padding is 22
# minutes, so the map projected those flights at roughly half the progress they had actually made.
# RJ440 on 15 Aug sat near the Jordanian border while it was 13 km from Amman.
#
# Measured over 14 days of the raw tape: the smallest computed block seen anywhere is 23 minutes,
# and there is no band below it at all. The old floor discarded 134 observations across 22 flights
# and rejected nothing bad, because nothing bad occurs. Ten leaves generous headroom under the
# smallest real value while still catching an est_arr that has collapsed onto its departure.
MIN_CREDIBLE_BLOCK_MIN = 10


def effective_duration(f: dict) -> int:
    """Actual departure to revised arrival when both are known — the schedule is padded."""
    dep, est_arr = iso(f.get("real_dep")), iso(f.get("est_arr"))
    if dep and est_arr:
        computed = round((est_arr - dep).total_seconds() / 60)
        if computed >= MIN_CREDIBLE_BLOCK_MIN:
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
        # FR24's landing where there is one, ours where there is not. A consumer asking "has it
        # arrived" wants one field, and `arr_confirmed` below says which kind of answer this is.
        "actual_arr_utc":  zulu(f.get("real_arr") or f.get("arr_confirmed_at")),
        # False when FR24 published the landing, true when we established it — from FR24's
        # last_seen, or from its own estimate for a flight it never resolved. Never shown as a
        # caveat; it is here so a surface can choose, and so punctuality figures can exclude it.
        "arr_confirmed":   bool(not f.get("real_arr") and f.get("arr_confirmed_at")),
        "arr_confirmed_src": f.get("arr_confirmed_src") if not f.get("real_arr") else None,
        "revised_dep_utc": zulu(revision(f.get("est_dep"), f.get("sched_dep"))),
        "revised_arr_utc": zulu(revision(f.get("est_arr"), f.get("sched_arr"))),
        # The arrival a countdown should run to, damped once here rather than in each client.
        # Null before there is an estimate worth the name, exactly like revised_arr_utc — a
        # flight still on its filed time has nothing to hold steady.
        "eta_stable_utc": stable_eta(f, zulu(revision(f.get("est_arr"), f.get("sched_arr")))),
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

    # Believe nothing impossible, whatever wrote it.
    #
    # Both fix sources are guarded, not just the aggregator, because the harvester writes direct
    # reception into this same table — a corrupt sweep upstream reaches clients through either
    # door. Keyed by fr24_id here: that is what identifies an airframe in this table.
    rows = drop_sentinel_fixes([r for r in rows if is_plausible_fix(r)], key="fr24_id")
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


async def circle_positions(client: httpx.AsyncClient) -> dict[str, dict]:
    """
    Direct ADS-B reception, keyed by callsign — the circles the website's map has always had.

    `aircraft_last_seen` is written continuously by the airspace poller from adsb.fi and
    adsb.lol. It never reached this service, so /v2/live carried FR24's sweep alone and the
    website merged the two itself in a Next.js route only it calls. That made the site
    structurally better informed than the app, and no amount of client work could close it.

    The harvester is supposed to fold direct reception into fr24_live_position with
    source='adsb', and that path exists — but measured 15 Aug it produced ONE row in thirty
    minutes while this table took a row every couple of seconds. So the merge was not happening
    anywhere a client could see it.

    Worth having on its own terms rather than for parity: the circles hear 32 of the 86 board
    flights that departed on 15 Aug, and they are 2-4 seconds old against FR24's 60-second
    sweep. For a third of the traffic this is both fresher and, where FR24 cannot see the
    aircraft at all, the only source.

    Keyed by callsign because that is all the table has — it is fed by hex from the feeds, with
    no fr24_id to join on. Upper-cased and stripped: ADS-B pads callsigns to eight characters.
    """
    cutoff = quote(
        (datetime.now(timezone.utc) - timedelta(seconds=FIX_STALE_SEC)).isoformat(), safe="")
    rows = await sb(
        client,
        "aircraft_last_seen?select=callsign,lat,lon,alt_baro,gs,track,seen_at"
        f"&seen_at=gte.{cutoff}&callsign=not.is.null&order=seen_at.desc",
    )
    # The door the 15-16 Aug corruption actually came through: 47 aircraft stamped on Queen
    # Alia airport with gs 0.7 while their altitudes stayed real. Keyed by callsign because
    # aircraft_last_seen has no hex to group by.
    rows = drop_sentinel_fixes([r for r in rows if is_plausible_fix(r)], key="callsign")

    out: dict[str, dict] = {}
    for r in rows:                            # ordered desc, so first of a callsign is newest
        cs = (r.get("callsign") or "").strip().upper()
        if cs and cs not in out and r.get("lat") is not None:
            out[cs] = r

    # Our own sweep wins wherever it has an answer.
    #
    # Same aggregators, seconds old instead of up to a minute: this table is written by a cron
    # that runs once a minute, so reading it made our freshest source arrive by our slowest
    # path. Measured 17 Aug, five of six flights were 58 seconds behind the website, which
    # sweeps the circles itself.
    #
    # The table stays underneath rather than being replaced. It survives a restart, it covers
    # the first ten seconds before the first sweep completes, and if the sweeper is failing it
    # is the difference between a slightly stale map and no map.
    live = adsb.positions()
    for cs, fix in live.items():
        out[cs] = _from_sweep(fix)
    return out


def _from_sweep(fix: dict) -> dict:
    """
    A swept fix in the shape aircraft_last_seen rows arrive in, so merge_position and everything
    downstream cannot tell which door a position came through.
    """
    return {
        "callsign": None,
        "lat": fix["lat"], "lon": fix["lon"],
        "alt_baro": fix.get("altitude_ft"),
        "gs": fix.get("ground_speed_kts"),
        "track": fix.get("track_deg"),
        "on_ground": fix.get("on_ground"),
        "seen_at": fix.get("fix_at"),
        "_swept": True,
    }


def merge_position(fr24: dict | None, circle: dict | None) -> dict | None:
    """
    One position per aircraft, from whichever source saw it last.

    Freshness decides, not source. Preferring a source outright is what made five flights on
    13 Aug render from four-minute-old ADS-B while four-second-old feed rows sat unused, and
    then lurch when the stale row aged out — the same mistake pointed the other way would be
    just as visible.

    Returned in the feed's shape whichever wins, so nothing downstream has to know a second
    table exists. The circles carry no vertical speed or on-ground flag; both are None rather
    than guessed, and a caller that needs them can tell the difference.
    """
    if circle is None:
        return fr24
    if fr24 is None:
        return _from_circle(circle)
    # iso() raises on a malformed value rather than returning None, and this is the one place
    # that compares a timestamp from a table the harvester does not own. A single unparseable
    # seen_at would otherwise take down the whole live document; here it simply loses the
    # comparison, which is the conservative answer anyway.
    try:
        a, b = iso(fr24.get("fix_at")), iso(circle.get("seen_at"))
    except (ValueError, TypeError):
        return fr24
    if a is None or b is None or a >= b:
        return fr24
    return _from_circle(circle)


def _from_circle(c: dict) -> dict:
    # on_ground is carried through rather than hardcoded to None. The table has no such column,
    # so a row read from it still yields None — but a swept fix knows the answer, and that field
    # is what lets derive_phase call a departure the moment the aircraft rotates instead of
    # waiting for 250 ft or for FR24.
    return {
        "lat": c.get("lat"), "lon": c.get("lon"),
        "altitude_ft": c.get("alt_baro"),
        "ground_speed_kts": c.get("gs"),
        "track_deg": c.get("track"),
        "vertical_speed_fpm": None,
        "on_ground": c.get("on_ground"),
        "fix_at": c.get("seen_at"),
        "source": "adsb",
    }


async def build_live() -> dict:
    async with httpx.AsyncClient() as client:
        aps = await airports(client)
        pos_by_id = await latest_positions(client)
        circles   = await circle_positions(client)

        # Everything with a fresh fix, whichever source produced it. A flight our own receivers
        # can see but FR24 has filed no live instance for is already here: the harvester wrote it
        # under the same fr24_id.
        flights: list[dict] = []
        if pos_by_id:
            ids = ",".join(f'"{i}"' for i in pos_by_id)
            flights = await sb(client, f"flight?select=*&fr24_id=in.({ids})")

        # Plus anything the circles can hear that FR24 has not filed a live position for.
        #
        # Selecting only on fr24_id meant an aircraft our own receivers could see was absent from
        # this document entirely unless FR24 also had it — so the coverage the circles buy could
        # never reach a client through here. Restricted to today and to flights that have
        # actually departed, because a callsign match alone would resurrect yesterday's instance
        # of the same number.
        if circles:
            known = {f.get("fr24_id") for f in flights}
            names = ",".join(f'"{c}"' for c in circles)
            day   = datetime.now(TZ).strftime("%Y-%m-%d")
            extra = await sb(
                client,
                f"flight?select=*&flight_date=eq.{day}&callsign=in.({names})"
                "&real_dep=not.is.null&real_arr=is.null",
            )
            flights += [f for f in extra if f.get("fr24_id") not in known]

        # Plus anything that landed recently, fix or no fix.
        #
        # Without this the ground phases derive_phase computes are unreachable. This document was
        # built only from positions newer than FIX_STALE_SEC, five minutes — and a landed aircraft
        # stops producing fixes, so it left the document about five minutes after touchdown and
        # took bags_on_belt, at_gate, taxi_to_gate and landed with it. Every one of them describes
        # a flight that has stopped moving, which is precisely when there is no fresh fix.
        #
        # An hour, because the belt is the last thing to arrive and arrives late: VF341's carousel
        # was published twenty minutes after it landed. The window has to outlast that gap by
        # enough that a reader who walks to arrivals still finds the number waiting.
        #
        # Both arrival columns. real_arr is FR24's published landing; arr_confirmed_at is ours,
        # for the flights it never resolves — Aleppo is silent on 22 of 35, and those readers need
        # the belt more than anyone, not less.
        #
        # Two queries rather than one or=(): the values are ISO timestamps full of characters
        # PostgREST treats as syntax inside or(), and quoting them correctly there is a footgun
        # for whoever edits this next. Cheap — this document is cached for LIVE_TTL.
        arr_cutoff = quote(
            (datetime.now(timezone.utc) - timedelta(seconds=ARRIVED_LINGER_SEC)).isoformat(), safe="")
        for column in ("real_arr", "arr_confirmed_at"):
            flights += await sb(client, f"flight?select=*&{column}=gte.{arr_cutoff}")

        if not flights:
            return {"as_of": now_iso(), "flights": []}

        # A flight can arrive by both routes — a fresh on-ground fix and a recent arrival, or both
        # arrival columns — and the reader must not see it twice. Keyed on the row's identity,
        # which is the table's own primary key.
        seen: set[tuple] = set()
        deduped: list[dict] = []
        for f in flights:
            key = (f.get("flight_date"), f.get("iata_number"), f.get("dep_iata"), f.get("arr_iata"))
            if key in seen:
                continue
            seen.add(key)
            deduped.append(f)
        flights = deduped

        # ── The flights nobody can hear ──────────────────────────────────────
        #
        # Everything above is built FROM a position, so a flight no feed can see was absent
        # from this document entirely — about one airborne flight in five, because ADS-B is
        # largely blind over Syria. That gap is the whole reason each client grew its own
        # corridor tracker, and the reason the two then disagreed: FYC361 drawn 190 km apart
        # on the site and the phone, one tracker closing a 298 km error while the other grew
        # it to 440 km.
        #
        # So they are pulled in here and projected below. Departed and not yet arrived, today
        # only — a callsign match alone would resurrect yesterday's instance of the number.
        day = datetime.now(TZ).strftime("%Y-%m-%d")
        have = {(f.get("flight_date"), f.get("iata_number"),
                 f.get("dep_iata"), f.get("arr_iata")) for f in flights}
        unheard = await sb(
            client,
            f"flight?select=*&flight_date=eq.{day}"
            "&real_dep=not.is.null&real_arr=is.null&arr_confirmed_at=is.null",
        )
        flights += [f for f in unheard
                    if (f.get("flight_date"), f.get("iata_number"),
                        f.get("dep_iata"), f.get("arr_iata")) not in have]

        paths = await route_paths(client)

    out = []
    for f in flights:
        # Whichever source saw this aircraft last — see merge_position.
        pos = merge_position(
            pos_by_id.get(f.get("fr24_id")),
            circles.get((f.get("callsign") or "").strip().upper()),
        )
        progress, p_basis = derive_progress(f, pos, aps)
        eta, e_basis = derive_eta(f)
        delay, d_basis = derive_delay(f)

        # A fix can be possible and still not be about this aeroplane.
        #
        # KNE591 on 16 Aug was served parked at Queen Alia two minutes before it landed at
        # Damascus, and every rule about a fix in isolation passed it. The website never drew it
        # because it draws the corridor and treats a fix as a nudge; the test map drew it, sat in
        # Jordan, and jumped to Damascus on arrival. Refusing it here gives the app the website's
        # robustness without giving it the website's blind spot, because a MOVING aircraft is
        # still believed wherever it is — which is what FYC361 needed.
        if pos is not None and fix_contradicts_flight(
            pos,
            aps.get(f.get("dep_iata") or ""),
            aps.get(f.get("arr_iata") or ""),
            arrived=bool(f.get("real_arr") or f.get("arr_confirmed_at")),
        ):
            pos = None

        # No fix — say where it should be, and say that is what we are doing.
        #
        # Counted against the stabilised arrival rather than the raw estimate, so the aeroplane
        # and the clock it is racing cannot disagree: a delay already absorbed into the countdown
        # slows the marker here instead of teleporting it on arrival.
        #
        # A recorded corridor when we have one, a great circle when we do not. Same shape either
        # way, so nothing downstream needs a second branch.
        projected = None
        if pos is None:
            dep_at = iso(f.get("real_dep"))
            arr_at = iso(stable_eta(f, eta) or eta)
            dep_c = aps.get(f.get("dep_iata") or "")
            arr_c = aps.get(f.get("arr_iata") or "")
            path = paths.get(f"{f.get('dep_iata')}|{f.get('arr_iata')}")
            if not path and dep_c and arr_c:
                path = great_circle_path(dep_c, arr_c)
            # ARRIVED_LINGER_SEC, the same window the arrival queries above use, so a flight
            # that has landed leaves the map at the same moment it leaves the arrivals list.
            drawable = within_projection_window(
                arr_at.timestamp() * 1000 if arr_at else None,
                datetime.now(timezone.utc).timestamp() * 1000,
                ARRIVED_LINGER_SEC * 1000,
            )
            if dep_at and arr_at and path and drawable:
                projected = project_position(
                    dep_at.timestamp() * 1000,
                    arr_at.timestamp() * 1000,
                    path,
                    datetime.now(timezone.utc).timestamp() * 1000,
                )
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
            # The same instant, held steady against wobble — what every surface should count
            # down to. eta_utc stays literal so the API goes on telling the truth about what
            # the feed said; this is the one both clients render.
            "eta_stable_utc": stable_eta(f, eta),
            "delay_min": delay,
            "delay_basis": d_basis,
            # One position field, whether we saw the aircraft or worked out where it must be.
            #
            # `pos_source` is published rather than inferred from which fields are null: a
            # reader is entitled to know the difference, and the marker needs it to fade.
            # Altitude and speed stay null on a projection — we do not know them, and inventing
            # a cruise altitude to fill the row is how a card ends up asserting 35,000 ft about
            # an aeroplane nobody can hear.
            "position": {
                "lat": pos["lat"], "lon": pos["lon"],
                "altitude_ft": pos.get("altitude_ft"),
                "ground_speed_kts": pos.get("ground_speed_kts"),
                "track_deg": pos.get("track_deg"),
                "vertical_speed_fpm": pos.get("vertical_speed_fpm"),
                "on_ground": pos.get("on_ground"),
                "fix_at": pos.get("fix_at"),
                "source": pos.get("source"),
                "pos_source": "observed",
            } if pos else {
                "lat": projected["lat"], "lon": projected["lon"],
                "altitude_ft": None,
                "ground_speed_kts": None,
                "track_deg": projected["track_deg"],
                "vertical_speed_fpm": None,
                "on_ground": False,
                "fix_at": None,
                "source": None,
                "pos_source": "projected",
                "fraction": projected["fraction"],
            } if projected else None,
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

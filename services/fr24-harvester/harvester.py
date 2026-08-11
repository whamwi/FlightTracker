#!/usr/bin/env python3
"""
Server-side FR24 harvest — records what FR24 says, every field, every refresh.

Why this exists
---------------
The board's schedule data currently arrives via the *visitor's browser*: warmFR24Cache in
app/board/page.tsx calls FR24 and POSTs the result to /api/fr24-cache. Only two pages do it, and
only on mount, so freshness tracks whoever happens to open the site. On 10 Aug 2026 RJ434 left
Aleppo at 10:06:45Z and did not reach the cache until 10:17:51Z — the moment someone opened
/fr24 on a desktop.

This does the same fetch from a server on a schedule of our choosing. It writes only
fr24_flight_raw and fr24_raw_probe. Nothing in either app reads those tables, so this can run,
be wrong, and be turned off without anyone noticing.

Append, never merge
-------------------
The predecessor upserted one row per flight, so each sweep overwrote the last and only the newest
value of every field survived. That answers "what does FR24 say now" and destroys "what did FR24
say before" — and the sequence is the interesting part: when an estimate first moved, how many
times it moved, whether a departure was announced before it was observed. None of it can be
recovered later, so this writes a row per flight per refresh and interprets nothing. `flight`
decides what is true; this only records what was said.

Why one long-lived process rather than a cron
---------------------------------------------
FR24 rate-limits at roughly thirty requests in quick succession, and the 429 arrives mid-sweep.
That budget is global, so it needs one pacer. Separate serverless invocations cannot coordinate:
two firing near each other each believe they are the only caller. A single process also keeps
backoff state between sweeps and is not bound by a 300-second invocation cap.

Why curl_cffi
-------------
api.flightradar24.com/common/v1/* answers 403 to any ordinary HTTP client — verified with and
without browser headers, from a residential IP, so it is client fingerprinting rather than IP or
auth. curl_cffi impersonates a browser's TLS fingerprint and gets 200 with no credentials. This
is the same door the browser path already uses; the only change is who knocks.

Environment
-----------
    SUPABASE_URL            required
    SUPABASE_SERVICE_KEY    required (service role — this writes)
    FR24_AIRPORTS           default "DAM,ALP"
    FR24_SWEEP_SECONDS      default 120
    FR24_REQUEST_DELAY      default 2.0
"""

from __future__ import annotations

import json
import os
import urllib.parse
import signal
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

from curl_cffi import requests as cr

# ── Configuration ────────────────────────────────────────────────────────────

SB_URL = os.environ["SUPABASE_URL"].rstrip("/")
# Service role in production. The anon key is accepted so the service can be exercised locally
# without a production secret on a laptop — it works only because RLS is off on these tables,
# which is the same footing fr24_daily_cache is already on and worth tightening before any of
# this stops being staging.
SB_KEY = (
    os.environ.get("SUPABASE_SERVICE_KEY")
    or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ["SUPABASE_ANON_KEY"]
)
SB_HEADERS = {
    "apikey": SB_KEY,
    "Authorization": f"Bearer {SB_KEY}",
    "Content-Type": "application/json",
}

AIRPORTS      = [a.strip().upper() for a in os.environ.get("FR24_AIRPORTS", "DAM,ALP").split(",") if a.strip()]
SWEEP_SECONDS = int(float(os.environ.get("FR24_SWEEP_SECONDS", "120")))
REQUEST_DELAY = float(os.environ.get("FR24_REQUEST_DELAY", "2.0"))

# Damascus is UTC+3 year round — the same assumption syriaDate() makes in both apps.
TZ = timezone(timedelta(hours=3))

BASE = "https://api.flightradar24.com/common/v1/airport.json"
IMPERSONATE = "chrome"

# limit caps at 100 server-side; anything larger is a 400. One page covers a Syrian airport,
# which files about seventy movements a day.
PAGE_LIMIT = 100
# page 1 is the window around now; page -1 is the one before it, which is the only way to reach
# yesterday — a past timestamp is refused with a 400.
PAGES = (1, -1)
RETRIES = 3
BACKOFF_SEC = 5

# A flight whose number FR24 omits, recovered from its registration. Carried over from the
# browser path rather than dropped: without it this aircraft arrives with no flight number.
REG_TO_FLIGHT = {"YK-BAA": "FYC728"}

# The browser path dropped anything over 300 minutes as FR24 pairing the wrong legs. That rule is
# right but it is a judgement, so it moves downstream to `flight`. Here the improbable leg is
# recorded like everything else — a filter at write time is a decision that cannot be revisited.

# A reference payload is kept once an hour; the rest are stored only on error or on change.
SAMPLE_EVERY_SEC = 3600

# Retention. The payload is bulk — 23KB a row — and its value is short-lived: it exists to be
# read while something is being validated, not kept. The metadata is the opposite, a few dozen
# bytes that answer "did this run and what came back", so it is kept far longer.
PAYLOAD_KEEP_DAYS = 7
PROBE_KEEP_DAYS   = 90

# The raw tape is the largest thing we write: measured at 8.4k rows an hour, ~202k a day. Five
# days is the intended window, matching the one already agreed for the live table.
#
# It ships **off**, and must stay off until compaction into flight_history exists. Deleting raw
# rows before anything durable has read them is not retention, it is loss on a timer — and it is
# the exact mistake the upsert made, only slower. Turn it on by setting FR24_RAW_KEEP_DAYS once
# there is somewhere for the data to go.
RAW_KEEP_DAYS     = int(os.environ.get("FR24_RAW_KEEP_DAYS", "0"))
PRUNE_EVERY_SEC   = 3600


# ── Live positions ───────────────────────────────────────────────────────────
#
# A second endpoint, and a different job. airport.json carries no position at all — no trail, no
# coordinates, verified across every stored payload — so a live fix needs its own call.
#
# One bounded request returns every aircraft in the box, keyed by the same fr24_id our schedule
# rows already carry. That is one request for all flights rather than one per flight, and the fix
# is 2-4 seconds old rather than wherever a track happened to end.

FEED_URL     = "https://data-cloud.flightradar24.com/zones/fcgi/feed.js"
# Gulf and Turkey. Measured: a Syria-only box found NONE of our two live flights, because both
# were still en route outside Syrian airspace; this box found both. Do not widen it — see
# FEED_CAP.
FEED_BOUNDS  = os.environ.get("FR24_FEED_BOUNDS", "45.0,22.0,25.0,60.0")
FEED_ENABLED = os.environ.get("FR24_FEED", "1") != "0"
# The response truncates at 1,500 aircraft without saying so. A box spanning Europe to India
# returned fewer of our flights than a smaller box inside it, because the cap discarded them.
# Tile boxes rather than enlarging one, and watch this number.
FEED_CAP     = 1500
# Half of all responses are empty, always carrying the frozen full_count 22684 while healthy ones
# return a moving count near 24,750. Two backends, one broken. Empty means retry.
FEED_RETRIES = 6
FEED_DEAD_COUNT = 22684


def log(msg: str) -> None:
    print(f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}  {msg}", flush=True)


# ── FR24 ─────────────────────────────────────────────────────────────────────

def ts(unix: int | None) -> str | None:
    return datetime.fromtimestamp(unix, timezone.utc).isoformat() if unix else None


def fetch_airport(code: str, day: str, page: int = 1) -> tuple[dict, int, int]:
    """The schedule payload for one airport, plus the HTTP status and how long it took."""
    midnight = int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=TZ).timestamp())
    url = (
        f"{BASE}?code={code}&plugin=&plugin-setting[schedule][mode]="
        f"&plugin-setting[schedule][timestamp]={midnight}"
        f"&page={page}&limit={PAGE_LIMIT}&fleet=&token="
    )
    started = time.monotonic()
    res = None
    for attempt in range(RETRIES):
        res = cr.get(url, impersonate=IMPERSONATE, timeout=30)
        if res.status_code != 429:
            break
        # The 429 arrives partway through a sweep and without warning. Backing off costs
        # seconds; not doing it loses whole airports, silently.
        time.sleep(BACKOFF_SEC * (attempt + 1))
    ms = int((time.monotonic() - started) * 1000)
    if res is None or res.status_code != 200:
        return {}, (res.status_code if res else 0), ms
    payload = res.json()
    sched = (
        payload.get("result", {}).get("response", {})
        .get("airport", {}).get("pluginData", {}).get("schedule", {})
    ) or {}
    return sched, 200, ms


def norm(entry: dict, source: str, page: int, direction: str, probe_uid: str) -> dict | None:
    """
    One FR24 schedule entry as a raw row, or None if it carries no usable identity or schedule.

    Only two rejections survive here, and both are "this is not a flight" rather than "this looks
    wrong": no identifier at all, and no scheduled times. Everything else — an implausible
    duration, a status that contradicts the timestamps, an airline we do not recognise — is
    recorded as sent and judged downstream. A filter applied at write time is a decision that
    cannot be revisited, and the whole point of this table is that it can be.
    """
    fl = entry.get("flight")
    if not fl:
        return None

    ident  = fl.get("identification") or {}
    time_  = fl.get("time") or {}
    ap     = fl.get("airport") or {}
    origin, dest = ap.get("origin") or {}, ap.get("destination") or {}
    airline = fl.get("airline") or {}
    craft   = fl.get("aircraft") or {}
    status  = fl.get("status") or {}

    reg = craft.get("registration")
    num = (
        ((ident.get("number") or {}).get("default"))
        or ident.get("callsign")
        or (REG_TO_FLIGHT.get(reg) if reg else None)
        or reg
    )
    if not num:
        return None

    sched = time_.get("scheduled") or {}
    sched_dep, sched_arr = sched.get("departure"), sched.get("arrival")
    if not sched_dep and not sched_arr:
        return None

    est, real = time_.get("estimated") or {}, time_.get("real") or {}
    other = time_.get("other") or {}
    o_info, d_info = origin.get("info") or {}, dest.get("info") or {}
    o_code, d_code = origin.get("code") or {}, dest.get("code") or {}
    al_code = airline.get("code") or {}
    model = craft.get("model") or {}

    # The one derivation allowed in a raw table, because it is the query key: FR24 files a
    # departure under the local day it was *scheduled* to leave, never the day it actually left.
    anchor = sched_dep or sched_arr
    flight_date = datetime.fromtimestamp(anchor, TZ).strftime("%Y-%m-%d")

    return {
        "probe_uid": probe_uid,
        "source_airport": source,
        "page": page,
        "direction": direction,
        "flight_date": flight_date,

        # The identity key. Present from the moment a flight is filed and stable across every
        # refresh, so it is what follows a leg through its life. `id` below is a different thing
        # despite the name — the *live instance* id, null until close to departure (0% more than
        # 12 hours out, 90% once departed), and the join key for tracks and route-path import.
        "fr24_row":     (ident.get("row") if isinstance(ident.get("row"), int)
                         else int(ident["row"]) if str(ident.get("row") or "").isdigit() else None),
        "fr24_id":      ident.get("id"),
        "num":          num,
        "callsign":     ident.get("callsign"),
        "airline_iata": al_code.get("iata"),
        "airline_icao": al_code.get("icao"),
        "airline_name": airline.get("name"),
        "reg":          reg,
        "hex":          (craft.get("identification") or {}).get("modes") or craft.get("hex"),
        "aircraft_code": model.get("code"),
        "aircraft_text": model.get("text"),

        "dep_iata": o_code.get("iata"),
        "dep_icao": o_code.get("icao"),
        "dep_name": origin.get("name"),
        "arr_iata": d_code.get("iata"),
        "arr_icao": d_code.get("icao"),
        "arr_name": dest.get("name"),

        "sched_dep":   ts(sched_dep),
        "sched_arr":   ts(sched_arr),
        "est_dep":     ts(est.get("departure")),
        "est_arr":     ts(est.get("arrival")),
        "real_dep":    ts(real.get("departure")),
        "real_arr":    ts(real.get("arrival")),
        "eta":         ts(other.get("eta")),
        "src_updated": ts(other.get("updated")),

        "dep_terminal": o_info.get("terminal"),
        "dep_gate":     o_info.get("gate"),
        "arr_terminal": d_info.get("terminal"),
        "arr_gate":     d_info.get("gate"),
        "arr_baggage":  d_info.get("baggage"),

        "status_text":    status.get("text"),
        "status_generic": ((status.get("generic") or {}).get("status") or {}).get("text"),
        "status_type":    ((status.get("generic") or {}).get("status") or {}).get("type"),
        "status_icon":    status.get("icon"),
        "status_live":    status.get("live"),

        # Verbatim, so a field nobody thought to extract is still there to be found.
        "raw": fl,
    }


# ── Supabase ─────────────────────────────────────────────────────────────────

def insert_flights(rows: list[dict]) -> int:
    """
    Send every entry; the table keeps only the ones that changed.

    The filter is a BEFORE INSERT trigger keyed on fr24_row, not logic here, for two reasons. It
    cannot be forgotten by another writer, and it does not depend on this process's memory — a
    restart would otherwise re-write every leg once, and a second harvester would double
    everything.

    Asking for the inserted ids back is what makes the skip observable: the response carries the
    rows that survived, so the difference between sent and kept is the measurement. `select=id`
    keeps that response a few bytes a row rather than the full payload.
    """
    if not rows:
        return 0
    res = cr.post(
        f"{SB_URL}/rest/v1/fr24_flight_raw?select=id",
        headers={**SB_HEADERS, "Prefer": "return=representation"},
        data=json.dumps(rows),
        impersonate=IMPERSONATE,
        timeout=60,
    )
    if res.status_code >= 300:
        log(f"  insert failed {res.status_code}: {res.text[:200]}")
        return 0
    try:
        return len(res.json())
    except Exception:                      # noqa: BLE001 — the write succeeded either way
        return -1


def record_probe(probe_uid: str, endpoint: str, fetch_by: str, query: str, page: int,
                 status: int, ms: int, rows: int, payload: dict | None,
                 legs_seen: list[int] | None = None) -> None:
    """
    Once unchanged flights stop being written, this is the only record that they were still there.
    Without legs_seen, "unchanged since 06:00" and "dropped out of FR24's window at 06:02" are
    indistinguishable — the same blind spot the upsert had, arriving by a different route.
    """
    body = {
        "probe_uid": probe_uid,
        "endpoint": endpoint, "fetch_by": fetch_by, "query": query, "page": page,
        "http_status": status, "duration_ms": ms, "rows_returned": rows,
        "payload": payload, "legs_seen": legs_seen or None,
    }
    res = cr.post(
        f"{SB_URL}/rest/v1/fr24_raw_probe",
        headers={**SB_HEADERS, "Prefer": "return=minimal"},
        data=json.dumps(body), impersonate=IMPERSONATE, timeout=60,
    )
    if res.status_code >= 300:
        log(f"  probe write failed {res.status_code}: {res.text[:200]}")


# ── Retention ────────────────────────────────────────────────────────────────

_last_prune = 0.0


def prune() -> None:
    """
    Drop old payloads, then old rows. Runs here rather than on a schedule of its own because
    this service is the only thing that writes them: if it is stopped, nothing accumulates and
    there is nothing to prune. A separate scheduler would be a second thing to keep alive for
    no gain.

    Payloads are nulled rather than deleted, so the record that a request happened — and what it
    returned — outlives the bytes it returned.
    """
    global _last_prune
    now = time.monotonic()
    if now - _last_prune < PRUNE_EVERY_SEC:
        return
    _last_prune = now

    # Percent-encoded, because an ISO timestamp ends in "+00:00" and a bare + in a query string
    # is a space: PostgREST answered 400 on "2026-08-10T18:19:48 00:00" until this was quoted.
    def cutoff(days: int) -> str:
        return urllib.parse.quote(
            (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(), safe="")

    try:
        r = cr.patch(
            f"{SB_URL}/rest/v1/fr24_raw_probe"
            f"?queried_at=lt.{cutoff(PAYLOAD_KEEP_DAYS)}&payload=not.is.null",
            headers={**SB_HEADERS, "Prefer": "return=representation"},
            data=json.dumps({"payload": None}), impersonate=IMPERSONATE, timeout=60,
        )
        cleared = len(r.json()) if r.status_code < 300 else -1

        r = cr.delete(
            f"{SB_URL}/rest/v1/fr24_raw_probe?queried_at=lt.{cutoff(PROBE_KEEP_DAYS)}",
            headers={**SB_HEADERS, "Prefer": "return=representation"},
            impersonate=IMPERSONATE, timeout=60,
        )
        dropped = len(r.json()) if r.status_code < 300 else -1

        raw_dropped = 0
        if RAW_KEEP_DAYS > 0:
            r = cr.delete(
                f"{SB_URL}/rest/v1/fr24_flight_raw?observed_at=lt.{cutoff(RAW_KEEP_DAYS)}",
                headers={**SB_HEADERS, "Prefer": "count=exact,return=minimal"},
                impersonate=IMPERSONATE, timeout=120,
            )
            raw_dropped = int((r.headers.get("content-range") or "/0").split("/")[-1] or 0) \
                if r.status_code < 300 else -1

        if cleared or dropped or raw_dropped:
            log(f"prune: {cleared} payloads cleared, {dropped} probes dropped, "
                f"{raw_dropped} raw rows dropped")
    except Exception as e:  # noqa: BLE001 — housekeeping must not end the service
        log(f"prune failed: {type(e).__name__}: {e}")


# ── Sweep ────────────────────────────────────────────────────────────────────

_last_sample: dict[str, float] = {}


def sweep() -> None:
    """
    Every airport, against yesterday's anchor as well as today's.

    FR24 files a departure under the day it was *scheduled* to leave, using the scheduled time
    and never the actual one. A flight due out at 22:50 and delayed to 00:15 therefore stays
    under yesterday — and at midnight "today" rolls over, so page 1 alone stops covering that
    flight at the exact moment it departs. Arrivals do not have the problem: they are filed by
    scheduled arrival, which is why a late-night landing appears to "move" to the next day of
    its own accord.

    Reached with page=-1 rather than yesterday's timestamp. A past anchor is refused outright —
    HTTP 400, with or without a schedule mode — while the earlier page returns it: 11 flights
    absent from page 1 on 10 Aug, including departures scheduled from 19:10 onward the evening
    before. The window already reaches forward on its own, so only the backward side needs
    asking for.
    """
    day = datetime.now(TZ).strftime("%Y-%m-%d")

    live: dict[str, int] = {}
    first = True
    for code in AIRPORTS:
        for page in PAGES:
            if not first:
                time.sleep(REQUEST_DELAY)
            first = False
            live.update(sweep_one(code, day, page))

    # The live set comes from the rows we just fetched rather than a second read of the database.
    # It is the same answer and one fewer round trip, and it cannot drift out of step with the
    # sweep that produced it.
    if live:
        time.sleep(REQUEST_DELAY)
    collect_positions(live)


def sweep_one(code: str, day: str, page: int = 1) -> dict[str, int]:
    probe_uid = str(uuid.uuid4())
    sched, status, ms = fetch_airport(code, day, page)

    # Both lists, kept apart. A domestic leg appears in DAM's departures and in ALP's arrivals,
    # and the two sides carry different detail — the departure side knows the gate, the arrival
    # side knows the belt. The predecessor deduplicated them to protect a primary key and so
    # threw away whichever side it saw second.
    rows = []
    for direction, key in (("departure", "departures"), ("arrival", "arrivals")):
        for e in ((sched.get(key) or {}).get("data") or []):
            r = norm(e, code, page, direction, probe_uid)
            if r:
                rows.append(r)

    written = insert_flights(rows)
    legs_seen = sorted({r["fr24_row"] for r in rows if r.get("fr24_row")})

    # Keep the raw payload when it failed, when it was empty, or once an hour as a
    # reference. Storing every sweep would be ~60MB a day for two airports.
    now = time.monotonic()
    keep = status != 200 or not rows or now - _last_sample.get(f"{code}|{page}", 0) > SAMPLE_EVERY_SEC
    if keep:
        _last_sample[f"{code}|{page}"] = now
    record_probe(probe_uid, "airport.json", "airport", code, page, status, ms, len(rows),
                 sched if keep else None, legs_seen)

    log(f"{code} p{page}: HTTP {status} {ms}ms  {len(rows)} seen  {written} changed"
        + (f"  ({len(rows) - written} unchanged)" if written >= 0 else "")
        + ("  [payload kept]" if keep else ""))

    # Flights worth asking the position feed about: any with a live instance. That covers the
    # whole arc, and both ends of it matter.
    #
    # Before departure, because `live` flips when the aircraft starts *moving* — 19 seconds after
    # RB504 began rolling and 14½ minutes before its departure time was published. After arrival,
    # because a landing is not the end: `live` stays true through roll-out and taxi, and FR24
    # publishes a provisional departure time it later corrects (16 of 168 legs), which position is
    # the only independent way to adjudicate. FYC727 was stated as departing 14:47:00 while our
    # fixes had it stationary at Damascus until 14:56:31; the corrected value, 14:57:48, sits
    # exactly where the position said it should.
    #
    # This previously excluded `real_arr`, so we stopped watching at touchdown and could check
    # departures but never arrivals. Bounded anyway — `live` goes false within about ten minutes
    # of landing, on every arrival observed so far.
    return {
        r["fr24_id"]: r["fr24_row"]
        for r in rows
        if r.get("fr24_id") and r.get("fr24_row") and r.get("status_live")
    }


def fetch_feed() -> tuple[dict, int]:
    """Every aircraft in the box, keyed by fr24_id, retrying past the broken backend."""
    url = (f"{FEED_URL}?bounds={FEED_BOUNDS}&faa=1&satellite=1&mlat=1&flarm=1&adsb=1"
           "&gnd=1&air=1&vehicles=0&estimated=1&maxage=14400&gliders=0&stats=0")
    for attempt in range(FEED_RETRIES):
        try:
            res = cr.get(url, impersonate=IMPERSONATE, timeout=40)
            if res.status_code != 200:
                time.sleep(2)
                continue
            payload = res.json()
            craft = {k: v for k, v in payload.items()
                     if k not in ("full_count", "version", "stats")}
            if craft:
                return craft, attempt + 1
            # Empty is the dead backend, not empty skies — the two are indistinguishable without
            # this retry, and treating it as "no flights" would look exactly like an outage.
            time.sleep(2)
        except Exception as e:                # noqa: BLE001 — positions must not end the sweep
            log(f"  feed attempt {attempt + 1} failed: {type(e).__name__}: {e}")
            time.sleep(2)
    return {}, FEED_RETRIES


def collect_positions(live: dict[str, int]) -> None:
    """
    Positions for our own flights, and only while some flight is actually live.

    `live` maps fr24_id -> fr24_row for flights FR24 currently reports as live and not yet
    arrived. When it is empty — overnight, or any quiet hour — no request is made at all, which
    is most of the value: the box costs ~170KB whether we need two aircraft from it or none.
    """
    if not FEED_ENABLED or not live:
        return

    craft, attempts = fetch_feed()
    if not craft:
        log(f"  feed: no aircraft after {attempts} attempts — backend down, positions skipped")
        return
    if len(craft) >= FEED_CAP:
        log(f"  feed: {len(craft)} aircraft AT THE {FEED_CAP} CAP — response truncated, "
            f"flights may be silently missing; narrow FR24_FEED_BOUNDS")

    rows = []
    for fid, v in craft.items():
        if fid not in live:
            continue                          # not ours; the other ~1,160 are overflights
        rows.append({
            "fr24_id": fid, "fr24_row": live[fid],
            "hex": v[0] or None, "lat": v[1], "lon": v[2], "track_deg": v[3],
            "altitude_ft": v[4], "ground_speed_kts": v[5], "squawk": v[6] or None,
            "source": v[7] or None, "aircraft_type": v[8] or None, "registration": v[9] or None,
            "fix_at": ts(v[10]), "origin_iata": v[11] or None, "dest_iata": v[12] or None,
            "flight_number": v[13] or None, "on_ground": bool(v[14]),
            "vertical_speed_fpm": v[15], "callsign": v[16] or None,
            "airline_icao": v[18] if len(v) > 18 else None,
            "aircraft_seen": len(craft), "raw": v,
        })

    if not rows:
        log(f"  feed: {len(craft)} aircraft, none of our {len(live)} live flights in the box")
        return

    res = cr.post(
        f"{SB_URL}/rest/v1/fr24_live_position?select=id",
        # The same fix asked for twice is one observation. Anything moving changes between polls,
        # so this only collapses a parked aircraft or a repeated response.
        headers={**SB_HEADERS, "Prefer": "resolution=ignore-duplicates,return=representation"},
        data=json.dumps(rows), impersonate=IMPERSONATE, timeout=60,
    )
    if res.status_code >= 300:
        log(f"  position write failed {res.status_code}: {res.text[:200]}")
        return
    try:
        kept = len(res.json())
    except Exception:                          # noqa: BLE001
        kept = -1
    ages = [int(time.time()) - v[10] for fid, v in craft.items() if fid in live]
    log(f"  feed: {len(craft)} aircraft, {len(rows)}/{len(live)} ours, {kept} new"
        f"  fix age {min(ages)}-{max(ages)}s" + (f"  [{attempts} attempts]" if attempts > 1 else ""))


def main() -> int:
    # One sweep and out, for checking a deploy or a change without waiting on the loop.
    if "--once" in sys.argv:
        log("single sweep")
        sweep()
        prune()
        return 0

    running = True

    def stop(*_):
        nonlocal running
        running = False
        log("stopping")

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    log(f"fr24-harvester up — airports={','.join(AIRPORTS)} sweep={SWEEP_SECONDS}s delay={REQUEST_DELAY}s")

    while running:
        started = time.monotonic()
        try:
            sweep()
            prune()
        except Exception as e:  # noqa: BLE001 — a bad sweep must not end the service
            log(f"sweep failed: {type(e).__name__}: {e}")
        # Sleep in short slices so SIGTERM is answered promptly rather than at the next sweep.
        while running and time.monotonic() - started < SWEEP_SECONDS:
            time.sleep(1)

    return 0


if __name__ == "__main__":
    sys.exit(main())

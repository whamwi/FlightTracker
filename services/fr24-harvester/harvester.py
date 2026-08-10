#!/usr/bin/env python3
"""
Server-side FR24 harvest — writes the staging tables, reads nothing, breaks nothing.

Why this exists
---------------
The board's schedule data currently arrives via the *visitor's browser*: warmFR24Cache in
app/board/page.tsx calls FR24 and POSTs the result to /api/fr24-cache. Only two pages do it, and
only on mount, so freshness tracks whoever happens to open the site. On 10 Aug 2026 RJ434 left
Aleppo at 10:06:45Z and did not reach the cache until 10:17:51Z — the moment someone opened
/fr24 on a desktop.

This does the same fetch from a server on a schedule of our choosing. It writes only
fr24_staging_flight and fr24_staging_probe. Nothing in either app reads those tables, so this
can run, be wrong, and be turned off without anyone noticing.

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

# Anything longer is FR24 pairing the wrong legs. Same cap as the browser path.
MAX_DURATION_MIN = 300

# A reference payload is kept once an hour; the rest are stored only on error or on change.
SAMPLE_EVERY_SEC = 3600

# Retention. The payload is bulk — 23KB a row — and its value is short-lived: it exists to be
# read while something is being validated, not kept. The metadata is the opposite, a few dozen
# bytes that answer "did this run and what came back", so it is kept far longer.
PAYLOAD_KEEP_DAYS = 7
PROBE_KEEP_DAYS   = 90
PRUNE_EVERY_SEC   = 3600


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


def norm(entry: dict, source: str) -> dict | None:
    """One FR24 schedule entry as a staging row, or None if unusable."""
    fl = entry.get("flight")
    if not fl:
        return None

    ident = fl.get("identification") or {}
    time_ = fl.get("time") or {}
    ap = fl.get("airport") or {}
    origin, dest = ap.get("origin") or {}, ap.get("destination") or {}

    reg = (fl.get("aircraft") or {}).get("registration")
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
    if not sched_dep or not sched_arr:
        return None
    if round((sched_arr - sched_dep) / 60) > MAX_DURATION_MIN:
        return None

    est, real = time_.get("estimated") or {}, time_.get("real") or {}
    o_info, d_info = origin.get("info") or {}, dest.get("info") or {}

    # Filed under the local date of its own scheduled departure, matching the browser path.
    flight_date = datetime.fromtimestamp(sched_dep, TZ).strftime("%Y-%m-%d")

    return {
        "source_airport": source,
        "flight_date": flight_date,
        "num": num,
        "dep_iata": ((origin.get("code") or {}).get("iata")) or "",
        "arr_iata": ((dest.get("code") or {}).get("iata")) or "",
        "fr24_id": ident.get("id"),
        "airline_iata": ((fl.get("airline") or {}).get("code") or {}).get("iata"),
        "aircraft": ((fl.get("aircraft") or {}).get("model") or {}).get("code"),
        "reg": reg,
        "sched_dep": ts(sched_dep),
        "sched_arr": ts(sched_arr),
        "est_dep": ts(est.get("departure")),
        "est_arr": ts(est.get("arrival")),
        "real_dep": ts(real.get("departure")),
        "real_arr": ts(real.get("arrival")),
        "dep_terminal": o_info.get("terminal"),
        "dep_gate": o_info.get("gate"),
        "arr_terminal": d_info.get("terminal"),
        "arr_gate": d_info.get("gate"),
        "arr_baggage": d_info.get("baggage"),
        "status": (fl.get("status") or {}).get("text"),
    }


# ── Supabase ─────────────────────────────────────────────────────────────────

def upsert_flights(rows: list[dict]) -> int:
    """
    Merge on the primary key. first_seen_at and the *_seen_at stamps are owned by the table's
    trigger, so they are never sent from here and cannot be overwritten by a later sweep.
    """
    if not rows:
        return 0
    res = cr.post(
        f"{SB_URL}/rest/v1/fr24_staging_flight",
        headers={**SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal"},
        data=json.dumps(rows),
        impersonate=IMPERSONATE,
        timeout=60,
    )
    if res.status_code >= 300:
        log(f"  upsert failed {res.status_code}: {res.text[:200]}")
        return 0
    return len(rows)


def record_probe(endpoint: str, fetch_by: str, query: str, page: int, status: int,
                 ms: int, rows: int, payload: dict | None) -> None:
    body = {
        "endpoint": endpoint, "fetch_by": fetch_by, "query": query, "page": page,
        "http_status": status, "duration_ms": ms, "rows_returned": rows,
        "payload": payload,
    }
    res = cr.post(
        f"{SB_URL}/rest/v1/fr24_staging_probe",
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

    cutoff_payload = cutoff(PAYLOAD_KEEP_DAYS)
    cutoff_row     = cutoff(PROBE_KEEP_DAYS)

    try:
        r = cr.patch(
            f"{SB_URL}/rest/v1/fr24_staging_probe"
            f"?queried_at=lt.{cutoff_payload}&payload=not.is.null",
            headers={**SB_HEADERS, "Prefer": "return=representation"},
            data=json.dumps({"payload": None}), impersonate=IMPERSONATE, timeout=60,
        )
        cleared = len(r.json()) if r.status_code < 300 else -1

        r = cr.delete(
            f"{SB_URL}/rest/v1/fr24_staging_probe?queried_at=lt.{cutoff_row}",
            headers={**SB_HEADERS, "Prefer": "return=representation"},
            impersonate=IMPERSONATE, timeout=60,
        )
        dropped = len(r.json()) if r.status_code < 300 else -1

        if cleared or dropped:
            log(f"prune: {cleared} payloads cleared, {dropped} rows dropped")
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

    first = True
    for code in AIRPORTS:
        for page in PAGES:
            if not first:
                time.sleep(REQUEST_DELAY)
            first = False
            sweep_one(code, day, page)


def sweep_one(code: str, day: str, page: int = 1) -> None:
    sched, status, ms = fetch_airport(code, day, page)
    entries = ((sched.get("departures") or {}).get("data") or []) + \
              ((sched.get("arrivals") or {}).get("data") or [])

    rows, seen = [], set()
    for e in entries:
        r = norm(e, code)
        if not r:
            continue
        # Arrivals and departures overlap for a domestic leg; the primary key would collide.
        key = (r["flight_date"], r["num"], r["dep_iata"], r["arr_iata"])
        if key in seen:
            continue
        seen.add(key)
        rows.append(r)

    written = upsert_flights(rows)

    # Keep the raw payload when it failed, when it was empty, or once an hour as a
    # reference. Storing every sweep would be ~60MB a day for two airports.
    now = time.monotonic()
    keep = status != 200 or not rows or now - _last_sample.get(f"{code}|{page}", 0) > SAMPLE_EVERY_SEC
    if keep:
        _last_sample[f"{code}|{page}"] = now
    record_probe("airport.json", "airport", code, page, status, ms, len(rows),
                 sched if keep else None)

    log(f"{code} p{page}: HTTP {status} {ms}ms  {len(rows)} rows  {written} written"
        + ("  [payload kept]" if keep else ""))


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

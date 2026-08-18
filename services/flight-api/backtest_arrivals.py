"""
Does asking FR24 about one flight tell us anything the widget did not?

Read-only. Writes nothing, wires nothing. Run against history rather than against live flights,
because history is where we already know what we failed to learn: 134 legs in the last fortnight
landed and were never given a real_arr, 97 of them at Damascus and Aleppo — the two airports the
widget is supposed to cover best.

Two questions, and the second matters as much as the first:

  FILL      of the legs we have no arrival time for, how many can this answer?
  AGREE     of the legs we DO have a time for, does it give the same time?

A source that fills gaps but disagrees with the times we already trust is not an upgrade, it is
a second opinion we would then have to arbitrate.
"""

import asyncio
import os
import sys
import urllib.parse
from collections import defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.expanduser("~/FlightTracker/services/flight-api"))
import arrivals                                                        # noqa: E402

import httpx                                                           # noqa: E402

SB_URL = os.environ["SUPABASE_URL"].rstrip("/")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ["SUPABASE_ANON_KEY"]
HEADERS = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

# FR24's per-flight list reaches back about a fortnight, and thins with age. Testing against
# legs older than that would measure the endpoint's memory, not its usefulness.
DAYS_BACK = 7
PAUSE_S = 1.2                       # this is a courtesy endpoint; do not hammer it


def fetch(params: str) -> list[dict]:
    r = httpx.get(f"{SB_URL}/rest/v1/flight?{params}", headers=HEADERS, timeout=60)
    r.raise_for_status()
    return r.json()


def ms(iso: str | None) -> float | None:
    if not iso:
        return None
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


COLS = "iata_number,callsign,dep_iata,arr_iata,sched_arr,real_arr"

def offsets() -> dict:
    """Arrival-airport UTC offsets, needed to read a local time out of the status text."""
    r = httpx.get(f"{SB_URL}/rest/v1/airports?select=iata,utc_offset",
                  headers=HEADERS, timeout=60)
    r.raise_for_status()
    return {x["iata"]: x["utc_offset"] for x in r.json() if x.get("utc_offset") is not None}

OFFSETS = {}


def sample(known: bool, limit: int) -> list[dict]:
    """Legs that have already landed, inside the endpoint's memory, split by whether we know when."""
    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=DAYS_BACK)).replace(microsecond=0).isoformat()
    until = (now - timedelta(hours=3)).replace(microsecond=0).isoformat()
    cond = "not.is.null" if known else "is.null"
    return fetch(f"select={COLS}&real_arr={cond}"
                 f"&sched_arr=gte.{urllib.parse.quote(since)}"
                 f"&sched_arr=lt.{urllib.parse.quote(until)}"
                 f"&order=sched_arr.desc&limit={limit}")


async def run(rows: list[dict], label: str) -> None:
    print(f"\n{'='*72}\n{label}: {len(rows)} legs\n{'='*72}")
    by_airport = defaultdict(lambda: {"n": 0, "hit": 0})
    deltas, misses = [], []

    for i, f in enumerate(rows):
        flight = {"iata_number": f["iata_number"], "callsign": f.get("callsign"),
                  "dep_iata": f["dep_iata"], "arr_iata": f["arr_iata"],
                  "sched_arr_ms": ms(f["sched_arr"])}
        try:
            hit = await arrivals.confirm_arrival(
                flight, OFFSETS.get(f['arr_iata']))
        except Exception as e:
            print(f"  error {f['iata_number']}: {e}")
            continue

        a = by_airport[f["arr_iata"]]
        a["n"] += 1
        if hit:
            a["hit"] += 1
            a.setdefault("precise", 0)
            a["precise"] += 1 if hit.get("precise") else 0
            if f.get("real_arr"):                       # control: compare against what we hold
                d = (hit["arrived_at_ms"] - ms(f["real_arr"])) / 60000.0
                deltas.append(d)
                if abs(d) > 5:
                    print(f"  DISAGREE {f['iata_number']:8} {f['dep_iata']}->{f['arr_iata']}"
                          f"  ours {f['real_arr'][11:16]}  theirs {hit['arrived_at'][11:16]}"
                          f"  {d:+.0f} min")
        else:
            misses.append(f)
        await asyncio.sleep(PAUSE_S)

    print(f"\n  {'airport':>8}  {'asked':>6}  {'answered':>9}  rate")
    tot_n = tot_h = 0
    for ap, v in sorted(by_airport.items(), key=lambda kv: -kv[1]["n"]):
        tot_n += v["n"]; tot_h += v["hit"]
        print(f"  {ap:>8}  {v['n']:6}  {v['hit']:9}  {100.0*v['hit']/v['n']:5.1f}%"
              f"   ({v.get('precise',0)} numeric, {v['hit']-v.get('precise',0)} from status text)")
    if tot_n:
        print(f"  {'TOTAL':>8}  {tot_n:6}  {tot_h:9}  {100.0*tot_h/tot_n:5.1f}%")

    if deltas:
        deltas.sort()
        exact = sum(1 for d in deltas if abs(d) <= 1)
        print(f"\n  agreement on {len(deltas)} legs we already had a time for:")
        print(f"    within 1 min : {exact}/{len(deltas)}  ({100.0*exact/len(deltas):.0f}%)")
        print(f"    median delta : {deltas[len(deltas)//2]:+.1f} min")
        print(f"    worst        : {deltas[0]:+.0f} / {deltas[-1]:+.0f} min")

    if misses:
        print(f"\n  still unanswered ({len(misses)}):")
        for m in misses[:10]:
            print(f"    {m['iata_number']:8} {m.get('callsign') or '—':8} "
                  f"{m['dep_iata']}->{m['arr_iata']}  sched {m['sched_arr'][:16]}")


async def main():
    global OFFSETS
    OFFSETS = offsets()
    print(f'offsets loaded for {len(OFFSETS)} airports')
    gaps = [r for r in sample(known=False, limit=400)
            if r.get("sched_arr") and r["iata_number"]][:45]
    ctrl = [r for r in sample(known=True, limit=200)
            if r.get("sched_arr") and r["iata_number"]][:25]
    await run(gaps, "GAPS — legs we have no arrival time for")
    await run(ctrl, "CONTROL — legs we already have a time for")
    print("\nstate:", arrivals.state())


if __name__ == "__main__":
    asyncio.run(main())

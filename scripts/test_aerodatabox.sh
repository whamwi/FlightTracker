#!/bin/bash
# AeroDataBox free tier test — 6 units total (600 available on free plan)
# Sign up at: https://apimarket.aerodatabox.com
# Then set your key below or: export AERODATABOX_KEY=your_key_here

KEY="${AERODATABOX_KEY:-YOUR_KEY_HERE}"
BASE="https://prod.api.market/api/v1/aedbx/aerodatabox"
H="x-api-market-key: $KEY"

echo "=== TEST 1: FYC743 live position (2 units) ==="
echo "Does Syria show up in real-time ADS-B coverage?"
curl -s -H "$H" "$BASE/flights/callsign/FYC743" | python3 -m json.tool 2>/dev/null | grep -E '"status"|"lat"|"lon"|"altitude"|"groundSpeed"|"callSign"|"number"' | head -20
echo ""

echo "=== TEST 2: Damascus (OSDI) FIDS — all flights now (2 units) ==="
curl -s -H "$H" "$BASE/flights/airports/icao/OSDI" | python3 -c "
import json, sys
d = json.load(sys.stdin)
flights = d.get('departures', []) + d.get('arrivals', [])
print(f'Total flights: {len(flights)}')
for f in flights[:15]:
    num = f.get('number','?')
    status = f.get('status','?')
    dep = f.get('departure',{})
    arr = f.get('arrival',{})
    sched = dep.get('scheduledTime',{}).get('utc','?') or arr.get('scheduledTime',{}).get('utc','?')
    other = (arr.get('airport',{}) or dep.get('airport',{})).get('iata','?')
    loc = f.get('location')
    pos = f'lat={loc[\"lat\"]:.2f} lon={loc[\"lon\"]:.2f}' if loc else 'no position'
    print(f'  {num:<10} {status:<15} {sched:<22} {other:<6} {pos}')
" 2>/dev/null || curl -s -H "$H" "$BASE/flights/airports/icao/OSDI" | python3 -m json.tool | head -40
echo ""

echo "=== TEST 3: Aleppo (ICPA) FIDS (2 units) ==="
curl -s -H "$H" "$BASE/flights/airports/icao/ICPA" | python3 -c "
import json, sys
d = json.load(sys.stdin)
flights = d.get('departures', []) + d.get('arrivals', [])
print(f'Total flights at ALP: {len(flights)}')
for f in flights[:10]:
    num = f.get('number','?')
    status = f.get('status','?')
    dep = f.get('departure',{})
    arr = f.get('arrival',{})
    other = (arr.get('airport',{}) or dep.get('airport',{})).get('iata','?')
    print(f'  {num:<10} {status:<15} {other}')
" 2>/dev/null || curl -s -H "$H" "$BASE/flights/airports/icao/ICPA" | python3 -m json.tool | head -30

echo ""
echo "=== Done. Used ~6 of 600 free units ==="

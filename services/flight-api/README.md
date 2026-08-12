# flight-api

Serves the two v2 documents the mobile app subscribes to. Runs on Railway beside the harvester;
the Next.js app is never redeployed for it.

    GET /v2/board?date=YYYY-MM-DD   schedule and slow facts
    GET /v2/live                    position and everything derived from it
    GET /health

Live at `https://flight-api-production-5124.up.railway.app`.

Contract: `docs/flight-contract-additions.md`.

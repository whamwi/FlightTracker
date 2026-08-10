# fr24-harvester

Server-side FR24 harvest into the staging tables. Reads nothing the apps depend on and writes
only `fr24_staging_flight` and `fr24_staging_probe`, so it can run, be wrong, or be switched off
without either app noticing.

It exists because the board's schedule data currently arrives via the visitor's browser, so
freshness tracks site traffic rather than a schedule. See the `FR24 Server-Side Refactor` note.

## Environment

| variable | required | default | notes |
|---|---|---|---|
| `SUPABASE_URL` | yes | — | |
| `SUPABASE_SERVICE_KEY` | yes | — | service role: this writes |
| `FR24_AIRPORTS` | no | `DAM,ALP` | comma separated |
| `FR24_SWEEP_SECONDS` | no | `120` | one sweep covers every airport |
| `FR24_REQUEST_DELAY` | no | `2.0` | spacing between requests |

## Why a worker and not a cron

FR24 rate-limits at roughly thirty requests in quick succession and the 429 arrives mid-sweep.
That budget is global, so it needs a single pacer holding backoff state between sweeps —
something separate serverless invocations cannot do, since each believes it is the only caller.

## Deploy

Railway service, root directory `services/fr24-harvester`. No port, no health check: it is a
worker, not a server.

## Checking it

```sql
-- did it run, and what came back
select queried_at, query, http_status, duration_ms, rows_returned
from fr24_staging_probe order by queried_at desc limit 20;

-- how quickly a departure reached us, which the live cache cannot answer
select num, dep_iata, arr_iata, real_dep, real_dep_seen_at,
       real_dep_seen_at - real_dep as lag
from fr24_staging_flight
where real_dep is not null
order by real_dep_seen_at desc limit 20;
```

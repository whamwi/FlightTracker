-- Live positions for our own flights, from FR24's bounded feed.
--
-- Why a second source at all: our own ADS-B cannot see Syria. Measured 11 Aug, nothing within
-- 100 km of Damascus below 1000 ft — the nearest low contacts were Beirut, 107 km away. FR24's
-- network can: it had J9173 at 2,050 ft on final into DAM and KU551's full roll-out on the
-- ground. This sits *beside* the airspace poll rather than replacing it; ours keeps working if
-- this unofficial endpoint closes, which is how `data-live` already ended.
--
-- Only our flights are stored. The feed returns ~1,170 aircraft for the region and perhaps a
-- handful are ours; the rest are overflights nothing will ever read.
--
-- Two measured constraints shape the collector:
--
--   * The response caps at 1,500 aircraft and truncates SILENTLY. A box spanning Europe to India
--     returned FEWER of our flights than a smaller box contained inside it, because the cap threw
--     ours away. Tile with several small boxes; never widen one. aircraft_seen is recorded on
--     every row so the cap can be watched rather than discovered.
--
--   * Half of all responses come back empty from a broken backend — always with the frozen
--     full_count 22684, while healthy ones return a moving count near 24,750. Zero aircraft means
--     retry, not "no flights". Without that, an outage is indistinguishable from quiet skies.
--
-- Append, not upsert, and deliberately so for now: we are still deciding how to use this, and a
-- cache of latest-only positions cannot be inspected after the fact. Once per-flight playback is
-- fetched at arrival — which returns the complete 4-second track regardless of when it is asked —
-- this becomes redundant history and can drop to one row per flight. Roughly 1.5k-15k rows a day
-- until then, which is nothing.

begin;

create table if not exists fr24_live_position (
  id            bigserial primary key,
  observed_at   timestamptz not null default now(),

  -- FR24's live-instance id: the feed is keyed by it, and so is our schedule row once the flight
  -- activates. No matching heuristics, which is what failed for FYC728 when a fix arrived with a
  -- null callsign and could not be attached to any flight.
  fr24_id       text not null,
  fr24_row      bigint,

  hex           text,
  callsign      text,
  flight_number text,
  registration  text,
  aircraft_type text,

  lat           double precision,
  lon           double precision,
  altitude_ft   integer,
  ground_speed_kts integer,
  track_deg     integer,
  vertical_speed_fpm integer,
  squawk        text,
  -- The feed carries ground traffic: 18-20 of ~97 aircraft on a typical response. This is the
  -- "standing at the origin airport" signal directly, rather than inferred from the rotation.
  on_ground     boolean,

  -- Which receiver type produced the fix — F-BDWY1, T-MLAT1 and so on. Worth keeping: it says
  -- whether a position is real ADS-B, multilateration, or estimated.
  source        text,
  origin_iata   text,
  dest_iata     text,
  airline_icao  text,

  -- The feed's own timestamp for the fix, distinct from when we asked. Measured 2-4 seconds old
  -- at fetch, occasionally up to a minute.
  fix_at        timestamptz,
  -- How many aircraft the response held, for watching the 1,500 cap.
  aircraft_seen integer,

  raw           jsonb
);

-- The same fix fetched twice is one observation, not two. Position genuinely changes between
-- polls for anything moving, so this only collapses a parked aircraft and a repeated response.
create unique index if not exists fr24_live_position_fix_uniq
  on fr24_live_position (fr24_id, fix_at);

create index if not exists fr24_live_position_flight_idx
  on fr24_live_position (fr24_row, fix_at desc);

create index if not exists fr24_live_position_observed_brin
  on fr24_live_position using brin (observed_at);

comment on table fr24_live_position is
  'Live positions for our own flights only, from data-cloud feed.js, polled only while a flight is live. Beside the airspace poll, not replacing it. Response caps at 1500 and truncates silently; empty responses are a broken backend, not empty skies.';

commit;

-- Don't promote FR24's estimated departure as if it were the observed one.
--
-- Reported 15 Aug 2026: a flight's marker jumps forward the moment it departs, then jumps back on
-- the next refresh, and the side card's progress bar with it. Both surfaces were reading
-- actual_dep_utc and both were right — the value under them changed.
--
-- FR24 flushes its own estimate into the real-departure field for one sweep before the actual
-- off-block arrives. Caught live on two flights within a minute of each other:
--
--   FDB1115  03:46:13  status "Scheduled"      real_dep 03:15:00   <- the estimate, verbatim
--            03:47:13  status "Estimated 09:24" real_dep 03:44:43   <- the off-block, 29m43s later
--   RJA432   03:45:20  status "Departed 06:41" real_dep 03:41:00
--            03:46:19  status "Departed 06:40" real_dep 03:40:51   <- 9s later
--
-- FDB1115 is the one a reader notices: for one minute the map drew it thirty minutes down a route
-- it had just left. RJA432's nine seconds nobody could see. The size of the jump is simply how
-- wrong the estimate was.
--
-- The tell is the seconds. An aircraft does not leave the gate on the stroke of the minute; an
-- estimate always does. Over 08–15 Aug, of 459 departures:
--
--   real_dep with seconds ..... 291 flights, 1 later corrected by >5 min  (0.3%)
--   real_dep on :00 ........... 168 flights, 113 later corrected by >5 min (68%), worst 74 min
--
-- Two refinements were measured and rejected. FR24's status_text still reading "Scheduled" while
-- handing over a departure raises the round-minute case from 55% to 84% bad, but is 0% bad on its
-- own — it sharpens nothing we do not already catch. And requiring the value to equal the estimate
-- we already hold splits the round-minute group 72/64/38% — all three bad, so the extra condition
-- only adds ways to be wrong.
--
-- So: a departure landing exactly on :00 is provisional. Hold it, and wait for one with seconds.
--
-- The ceiling exists because 20 of the 168 are never corrected — FR24 sends :00 and means it, or
-- simply never revises. Without a release those flights would never depart. Simulated against the
-- full tape:
--
--   ceiling   prevented   missed   avg latency   worst
--     2 min       97        17         28 s       2 min
--     5 min      110         4         37 s       5 min
--    10 min      111         3         51 s      10 min
--    30 min      111         3        105 s      30 min
--
-- Five minutes is the knee: ten buys one more flight for twice the wait. The cost is that every
-- departure on a round minute appears up to five minutes late; the benefit is that 110 of 115
-- flights stop showing a departure wrong by more than five minutes, worst case 74.
--
-- The clock is `new.observed_at`, not `now()`. This function has to stay replayable — the whole
-- reason the raw tape is append-only is that rules change and `flight` gets rebuilt by touching
-- each row in observation order. A hold measured against wall-clock time would accept everything
-- on replay and quietly rebuild the bug.

begin;

alter table flight add column if not exists dep_provisional_since timestamptz;

comment on column flight.dep_provisional_since is
  'When we first refused a :00-second real_dep as FR24''s estimate rather than an observation. Null once a departure is accepted. Measured against fr24_flight_raw.observed_at so replay is deterministic.';

create or replace function fr24_raw_to_flight() returns trigger
language plpgsql as $$
declare
  v_num       text := new.num;
  v_iata      text;
  v_callsign  text;
  v_dep       text;
  v_arr       text;
  al          record;
  v_real_dep  timestamptz;
  v_prev_real timestamptz;
  v_prov      timestamptz;
begin
  -- Not a flight: no identifier, or no schedule to hang it on.
  if v_num is null or new.sched_dep is null or new.sched_arr is null then
    return null;
  end if;

  -- Identity. FR24 files some carriers under the IATA number and some under the callsign, so the
  -- raw `num` may be either. Resolve through `airlines`, which carries both codes for every
  -- airline in the scheme — the lookup table can miss a row, the airline table does not.
  select a.iata into v_iata
    from airlines a
   where a.icao is not null and a.icao = left(v_num, 3)
   limit 1;

  if v_iata is not null and length(v_num) > 3 then
    v_callsign := v_num;
    v_iata     := v_iata || substring(v_num from 4);
  else
    v_iata     := v_num;
    v_callsign := nullif(new.callsign, '');
  end if;

  -- Airline prefix: three characters where an airline uses one, otherwise two.
  select * into al from airlines a where a.iata = left(v_iata, 3) limit 1;
  if not found then
    select * into al from airlines a where a.iata = left(v_iata, 2) limit 1;
  end if;

  -- The codeshare filter. FR24 emits shared codes that look like legitimate flights; the rule is
  -- that a code must belong to a known airline. An unknown prefix is not a flight we show.
  if not found then
    return null;
  end if;

  -- Both identifiers, always. Whichever form FR24 omitted is derived from the airline's pair.
  if v_callsign is null and al.icao is not null then
    v_callsign := al.icao || substring(v_iata from length(al.iata) + 1);
  end if;

  -- FR24 omits the observing airport's own code — an arrival at ALP carries no arr_iata because
  -- from that feed's point of view it is implied. Fill it from the source, or half the board
  -- loses an endpoint.
  v_dep := coalesce(nullif(new.dep_iata, ''), new.source_airport);
  v_arr := coalesce(nullif(new.arr_iata, ''), new.source_airport);

  -- ── The provisional-departure guard ──────────────────────────────────────────────────────────
  -- What we already hold for this leg, which decides whether an incoming :00 value is the first
  -- word on the subject or a downgrade of something better.
  select f.real_dep, f.dep_provisional_since
    into v_prev_real, v_prov
    from flight f
   where f.flight_date = new.flight_date and f.iata_number = v_iata
     and f.dep_iata = v_dep and f.arr_iata = v_arr;

  v_real_dep := new.real_dep;

  -- Only a flight still in the air is worth protecting: the guard exists so a marker does not jump
  -- down its route, and a landed flight has no marker. Once the arrival is known, holding the
  -- departure back can only lose it. Replaying 08–15 Aug without this clause left four flights with
  -- no departure at all — each seen exactly once, so the hold was never released. All four are from
  -- 09–11 Aug, when the harvester was still being brought up; from 12 Aug on, no flight is observed
  -- fewer than twice and the case cannot arise. It is guarded anyway, because "cannot arise" is a
  -- statement about today's polling interval and not about the rule.
  --
  -- This clause recovers three of the four. ABY376 on 10 Aug stays lost: one poll, round-minute
  -- departure, and no arrival either, so there is nothing to release the hold and nothing to say
  -- the flight is down. A flight we observe exactly once while it is still in the air is beyond
  -- what this rule can serve, and building for it would mean trusting the value we just measured
  -- as 68% wrong.
  if v_real_dep is not null and new.real_arr is null and extract(second from v_real_dep) = 0 then
    if v_prev_real is not null and extract(second from v_prev_real) <> 0 then
      -- We already have an observed departure. A round-minute value arriving afterwards is the
      -- estimate coming back, and must not overwrite what was actually seen.
      v_real_dep := null;
    else
      v_prov := coalesce(v_prov, new.observed_at);
      if new.observed_at - v_prov < interval '5 minutes' then
        v_real_dep := null;   -- hold: est_dep still carries it, so the flight reads as expected
      end if;
    end if;
  else
    -- Seconds present, or no departure at all. Nothing is being held.
    v_prov := null;
  end if;

  insert into flight (
    flight_date, iata_number, dep_iata, arr_iata,
    callsign, fr24_id, airline_iata, aircraft_type, registration,
    sched_dep, sched_arr, est_dep, est_arr, real_dep, real_arr,
    dep_provisional_since,
    dep_terminal, dep_gate, arr_terminal, arr_gate, arr_baggage,
    outcome, sources, first_seen_at, updated_at
  ) values (
    new.flight_date, v_iata, v_dep, v_arr,
    v_callsign, nullif(new.fr24_id, ''), al.iata,
    nullif(new.aircraft_code, ''), nullif(new.reg, ''),
    new.sched_dep, new.sched_arr, new.est_dep,
    -- Retired the moment the actual arrival is known.
    case when new.real_arr is not null then null else new.est_arr end,
    v_real_dep, new.real_arr,
    v_prov,
    nullif(new.dep_terminal, ''), nullif(new.dep_gate, ''),
    nullif(new.arr_terminal, ''), nullif(new.arr_gate, ''), nullif(new.arr_baggage, ''),
    case when v_real_dep is not null then 'departed' else 'unknown' end,
    array[new.source_airport], now(), now()
  )
  on conflict (flight_date, iata_number, dep_iata, arr_iata) do update set
    -- Take latest where a value has never been observed going backwards; coalesce is equivalent
    -- and safe, since "latest is null" only ever means "not mentioned this time".
    callsign      = coalesce(excluded.callsign,      flight.callsign),
    fr24_id       = coalesce(excluded.fr24_id,       flight.fr24_id),
    aircraft_type = coalesce(excluded.aircraft_type, flight.aircraft_type),
    registration  = coalesce(excluded.registration,  flight.registration),
    sched_dep     = excluded.sched_dep,
    sched_arr     = excluded.sched_arr,
    est_dep       = coalesce(excluded.est_dep,  flight.est_dep),
    -- The one field with a rule of its own: kept while the flight is airborne, cleared once it
    -- has landed. 48 of 48 observed nulls were the landing, not a lapse.
    est_arr       = case when coalesce(excluded.real_arr, flight.real_arr) is not null
                         then null
                         else coalesce(excluded.est_arr, flight.est_arr) end,
    real_dep      = coalesce(excluded.real_dep, flight.real_dep),
    real_arr      = coalesce(excluded.real_arr, flight.real_arr),
    -- Cleared by the guard above the moment a departure is accepted, so this is only ever set
    -- while we are actively refusing one.
    dep_provisional_since = excluded.dep_provisional_since,
    dep_terminal  = coalesce(excluded.dep_terminal, flight.dep_terminal),
    dep_gate      = coalesce(excluded.dep_gate,     flight.dep_gate),
    arr_terminal  = coalesce(excluded.arr_terminal, flight.arr_terminal),
    arr_gate      = coalesce(excluded.arr_gate,     flight.arr_gate),
    -- Withdrawn once in the observed data, so last non-null rather than latest.
    arr_baggage   = coalesce(excluded.arr_baggage,  flight.arr_baggage),
    outcome       = case when coalesce(excluded.real_dep, flight.real_dep) is not null
                         then 'departed' else flight.outcome end,
    -- Which feeds have reported this leg. One flight, several observers.
    sources       = case when flight.sources @> excluded.sources then flight.sources
                         else flight.sources || excluded.sources end;

  return null;
end $$;

comment on function fr24_raw_to_flight() is
  'Maintains the canonical `flight` row from each raw insert: resolves identity through airlines, applies the codeshare filter, fills the endpoint FR24 implies, holds a :00-second real_dep as FR24''s estimate for up to 5 minutes, and merges per measured field rules.';

commit;

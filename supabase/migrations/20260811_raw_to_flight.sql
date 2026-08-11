-- Populate `flight` from the raw tape, on every raw insert.
--
-- A trigger rather than a scheduled job because insert-on-change made it cheap: only ~840 raw
-- rows arrive in two hours, so maintaining the canonical row per insert costs nothing, is always
-- consistent, needs no scheduler, and cannot be forgotten by a future writer. That bet already
-- paid once today — the previous harvester build was filtered correctly by the insert-on-change
-- trigger without knowing the rule existed.
--
-- The merge rules are measured, not assumed. Across every raw row so far, counting how often a
-- value we had been given was taken back:
--
--   real_dep, real_arr, hex, fr24_id, gates, aircraft type ... 0 times  -> take latest
--   callsign ................................................ 2 times  -> keep last non-null
--   arr_baggage ............................................. 1 time   -> keep last non-null
--   est_arr ................................................ 48 times  -> see below
--
-- All 48 est_arr nulls happened *after the flight had landed*. That is not the feed forgetting,
-- it is the estimate being correctly retired once the actual arrival is known — so a blanket
-- never-downgrade rule would pin a stale estimate onto every landed flight. est_arr is preserved
-- while airborne and cleared once real_arr exists.
--
-- flight_stamp() already owns updated_at, the *_seen_at stamps, and never-unlearn for real_dep
-- and real_arr, so none of that is repeated here.

begin;

create or replace function fr24_raw_to_flight() returns trigger
language plpgsql as $$
declare
  v_num       text := new.num;
  v_iata      text;
  v_callsign  text;
  v_prefix    text;
  v_dep       text;
  v_arr       text;
  al          record;
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

  insert into flight (
    flight_date, iata_number, dep_iata, arr_iata,
    callsign, fr24_id, airline_iata, aircraft_type, registration,
    sched_dep, sched_arr, est_dep, est_arr, real_dep, real_arr,
    dep_terminal, dep_gate, arr_terminal, arr_gate, arr_baggage,
    outcome, sources, first_seen_at, updated_at
  ) values (
    new.flight_date, v_iata, v_dep, v_arr,
    v_callsign, nullif(new.fr24_id, ''), al.iata,
    nullif(new.aircraft_code, ''), nullif(new.reg, ''),
    new.sched_dep, new.sched_arr, new.est_dep,
    -- Retired the moment the actual arrival is known.
    case when new.real_arr is not null then null else new.est_arr end,
    new.real_dep, new.real_arr,
    nullif(new.dep_terminal, ''), nullif(new.dep_gate, ''),
    nullif(new.arr_terminal, ''), nullif(new.arr_gate, ''), nullif(new.arr_baggage, ''),
    case when new.real_dep is not null then 'departed' else 'unknown' end,
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

-- INSERT is the real path; raw is append-only and never updated in normal operation. UPDATE is
-- included so the tape can be replayed through this function in observation order — touch each
-- row by id in `observed_at` sequence and the merge sees exactly the order it would have seen
-- live. Without that there is no way to rebuild `flight` from history after a rule changes, and
-- rule changes are the entire reason the raw tape exists.
drop trigger if exists fr24_raw_to_flight_trg on fr24_flight_raw;
create trigger fr24_raw_to_flight_trg
  after insert or update on fr24_flight_raw
  for each row execute function fr24_raw_to_flight();

comment on function fr24_raw_to_flight() is
  'Maintains the canonical `flight` row from each raw insert: resolves identity through airlines, applies the codeshare filter, fills the endpoint FR24 implies, and merges per measured field rules.';

commit;

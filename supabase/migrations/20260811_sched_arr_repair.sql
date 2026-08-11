-- Repair FR24's day-early scheduled arrivals in `flight`.
--
-- RB272 DAM-AMS on 11 Aug 2026, straight from the payload:
--
--   sched_dep  1786456800 -> 2026-08-11 14:00:00Z   correct
--   sched_arr  1786388400 -> 2026-08-10 19:00:00Z   ONE DAY EARLY
--   est_arr    1786475638 -> 2026-08-11 19:13:58Z   correct
--
-- The correct arrival is 1786474800 — the value sent is short by exactly 86,400 seconds.
-- Flightradar's own website renders it correctly as 21:00 Amsterdam time, so their UI either
-- reads a different field or repairs it before display; the API does not. The estimated arrival
-- in the same payload is right and matches their page to the minute, which is what rules out any
-- parsing fault at our end.
--
-- The damage is not cosmetic. A scheduled duration of -1140 minutes propagates into anything that
-- computes from the schedule: the board only survives because it falls back to real_dep -> est_arr
-- for duration, and the aircraft went missing from the map for the whole flight.
--
-- Repaired here rather than in the harvester, deliberately. `fr24_flight_raw` keeps exactly what
-- FR24 sent, so the defect stays visible and measurable; `flight` holds what is true. Same split
-- that keeps the K3 rows on the tape while excluding them from the board.
--
-- Bounded to two days. The observed offset is exactly one, and no route we serve is longer than
-- five hours — if two additions still leave the arrival before the departure, that is a different
-- defect and should be left visible rather than papered over.

begin;

create or replace function fr24_raw_to_flight() returns trigger
language plpgsql as $$
declare
  v_num       text := new.num;
  v_iata      text;
  v_callsign  text;
  v_dep       text;
  v_arr       text;
  v_sched_arr timestamptz;
  al          record;
begin
  if v_num is null or new.sched_dep is null or new.sched_arr is null then
    return null;
  end if;

  -- Identity: FR24 files some carriers under the IATA number and some under the callsign.
  -- Resolve through `airlines`, which carries both codes for every airline in the scheme.
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

  select * into al from airlines a where a.iata = left(v_iata, 3) limit 1;
  if not found then
    select * into al from airlines a where a.iata = left(v_iata, 2) limit 1;
  end if;

  -- The codeshare filter, confirmed with the user 11 Aug: no entry in `airlines`, not a flight.
  if not found then
    return null;
  end if;

  if v_callsign is null and al.icao is not null then
    v_callsign := al.icao || substring(v_iata from length(al.iata) + 1);
  end if;

  v_dep := coalesce(nullif(new.dep_iata, ''), new.source_airport);
  v_arr := coalesce(nullif(new.arr_iata, ''), new.source_airport);

  -- The repair. An arrival at or before its own departure is impossible, and the offset observed
  -- is whole days, so advancing by a day is a correction rather than a guess.
  v_sched_arr := new.sched_arr;
  for _ in 1..2 loop
    exit when v_sched_arr > new.sched_dep;
    v_sched_arr := v_sched_arr + interval '1 day';
  end loop;

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
    new.sched_dep, v_sched_arr, new.est_dep,
    case when new.real_arr is not null then null else new.est_arr end,
    new.real_dep, new.real_arr,
    nullif(new.dep_terminal, ''), nullif(new.dep_gate, ''),
    nullif(new.arr_terminal, ''), nullif(new.arr_gate, ''), nullif(new.arr_baggage, ''),
    case when new.real_dep is not null then 'departed' else 'unknown' end,
    array[new.source_airport], now(), now()
  )
  on conflict (flight_date, iata_number, dep_iata, arr_iata) do update set
    callsign      = coalesce(excluded.callsign,      flight.callsign),
    fr24_id       = coalesce(excluded.fr24_id,       flight.fr24_id),
    aircraft_type = coalesce(excluded.aircraft_type, flight.aircraft_type),
    registration  = coalesce(excluded.registration,  flight.registration),
    sched_dep     = excluded.sched_dep,
    sched_arr     = excluded.sched_arr,
    est_dep       = coalesce(excluded.est_dep,  flight.est_dep),
    -- 48 of 48 observed est_arr nulls happened after landing: the estimate being retired once the
    -- actual is known, not the feed forgetting.
    est_arr       = case when coalesce(excluded.real_arr, flight.real_arr) is not null
                         then null
                         else coalesce(excluded.est_arr, flight.est_arr) end,
    real_dep      = coalesce(excluded.real_dep, flight.real_dep),
    real_arr      = coalesce(excluded.real_arr, flight.real_arr),
    dep_terminal  = coalesce(excluded.dep_terminal, flight.dep_terminal),
    dep_gate      = coalesce(excluded.dep_gate,     flight.dep_gate),
    arr_terminal  = coalesce(excluded.arr_terminal, flight.arr_terminal),
    arr_gate      = coalesce(excluded.arr_gate,     flight.arr_gate),
    arr_baggage   = coalesce(excluded.arr_baggage,  flight.arr_baggage),
    outcome       = case when coalesce(excluded.real_dep, flight.real_dep) is not null
                         then 'departed' else flight.outcome end,
    sources       = case when flight.sources @> excluded.sources then flight.sources
                         else flight.sources || excluded.sources end;

  return null;
end $$;

commit;

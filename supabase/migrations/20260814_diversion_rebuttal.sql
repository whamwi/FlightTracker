-- A diversion FR24 inferred from a position we can prove false.
--
-- Two flights on 14 Aug, both inbound to Damascus, both marked "Diverted to AMM" within minutes of
-- their estimate expiring, neither of which diverted. KU551 was last really seen 50 km out at
-- 12,350 ft descending; ABY375 27 km out at 7,925 ft descending. Both then reported 31.720/36.000,
-- held it for several minutes while their altitude fell, and FR24 — reading a position on top of
-- Queen Alia — published a diversion.
--
-- That coordinate is not a place. Thirteen different aircraft have broadcast it, from ground level
-- to 32,975 ft, at up to 940 knots. Compare the Damascus apron at 33.410/36.520: fifty aircraft,
-- every one at altitude zero, none above 37 knots. That is what a real shared coordinate looks
-- like. 31.720/36.000 is the anchor of the GPS spoofing over southern Syria, and it happens to sit
-- on an airport, which is the whole reason these come out as diversions rather than as noise.
--
-- The outcome was sticky against everything except a published real_arr, and FR24 will never
-- publish one: as far as it knows both aircraft are parked at Amman. So the diversion was
-- permanent, and both flights would have stayed wrong in the punctuality figures for good.
--
-- What changes: an arrival confirmed by *our own positions* now outranks the diversion. Only that
-- source. The other two confirmation tiers stay below it, and deliberately — fr24_last_seen and
-- fr24_estimate are both FR24 reasoning about the same track that produced the diversion, so
-- letting them overturn it would just be FR24 arguing with itself. position_rebuttal is different
-- in kind: it is a fix from a receiver, and it is the only thing here that observed the aircraft
-- rather than inferring it.
--
-- Only the outcome expression in the update branch changed; the rest is reproduced verbatim.
create or replace function public.fr24_raw_to_flight()
 returns trigger
 language plpgsql
as $function$
declare
  v_num       text := new.num;
  v_iata      text;
  v_callsign  text;
  v_dep       text;
  v_arr       text;
  v_sched_arr timestamptz;
  v_status    text := lower(coalesce(nullif(new.status_generic, ''), new.status_text, ''));
  v_cancelled boolean;
  v_diverted  boolean;
  al          record;
begin
  if v_num is null or new.sched_dep is null or new.sched_arr is null then
    return null;
  end if;

  v_cancelled := v_status like '%cancel%';
  v_diverted  := v_status like '%divert%';

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
  if not found then
    return null;
  end if;

  if v_callsign is null and al.icao is not null then
    v_callsign := al.icao || substring(v_iata from length(al.iata) + 1);
  end if;

  v_dep := coalesce(nullif(new.dep_iata, ''), new.source_airport);
  v_arr := coalesce(nullif(new.arr_iata, ''), new.source_airport);

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
    new.sched_dep, v_sched_arr,
    case when new.real_dep is not null then null else new.est_dep end,
    case when new.real_arr is not null then null else new.est_arr end,
    new.real_dep, new.real_arr,
    nullif(new.dep_terminal, ''), nullif(new.dep_gate, ''),
    nullif(new.arr_terminal, ''), nullif(new.arr_gate, ''), nullif(new.arr_baggage, ''),
    -- Arrival first here too: a row carrying both an arrival and a diversion describes a flight
    -- that got where it was going.
    case when new.real_arr is not null then 'arrived'
         when v_diverted              then 'diverted'
         when new.real_dep is not null then 'departed'
         when v_cancelled             then 'cancelled'
         else 'unknown' end,
    array[new.source_airport], now(), now()
  )
  on conflict (flight_date, iata_number, dep_iata, arr_iata) do update set
    callsign      = coalesce(excluded.callsign,      flight.callsign),
    fr24_id       = coalesce(excluded.fr24_id,       flight.fr24_id),
    aircraft_type = coalesce(excluded.aircraft_type, flight.aircraft_type),
    registration  = coalesce(excluded.registration,  flight.registration),
    sched_dep     = excluded.sched_dep,
    sched_arr     = excluded.sched_arr,
    est_dep       = case when coalesce(excluded.real_dep, flight.real_dep) is not null
                         then null
                         else coalesce(excluded.est_dep, flight.est_dep) end,
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
    outcome       = case
                      -- Proof, and it outranks everything. The flight reached the airport it was
                      -- filed to; whatever FR24 inferred on the way is settled by that.
                      when coalesce(excluded.real_arr, flight.real_arr) is not null
                        then 'arrived'
                      -- Our receivers watched it approach the airport it was filed to, and the
                      -- position the diversion rests on is one no aircraft was ever in. An
                      -- observation outranks an inference drawn from a fabricated fix.
                      when flight.arr_confirmed_src = 'position_rebuttal'
                        then 'arrived'
                      -- Sticky against FR24 flapping, but no longer against evidence.
                      when v_diverted or flight.outcome = 'diverted' then 'diverted'
                      -- Our own assumption. Below the diversion branch deliberately: an inferred
                      -- arrival must not overturn a reported one, only an observed arrival may.
                      when flight.arr_confirmed_at is not null
                        then 'arrived'
                      when coalesce(excluded.real_dep, flight.real_dep) is not null
                        then 'departed'
                      when v_cancelled or flight.outcome = 'cancelled' then 'cancelled'
                      else flight.outcome
                    end,
    sources       = case when flight.sources @> excluded.sources then flight.sources
                         else flight.sources || excluded.sources end;

  return null;
end
$function$;


-- The rebuttal itself, in SQL because it needs a window function over the position tape and the
-- caller reaches this database through PostgREST, which has none.
--
-- Three things must all hold before a reported diversion is overturned, and each is doing work:
--
--   the destination is Syrian     — this is where FR24's coverage fails and where the spoofing is.
--                                   Elsewhere its diversions are as good as its arrivals.
--   the transmitter went frozen   — a coordinate repeated exactly while the altitude moved. This
--                                   is the part that says the diversion rests on a fiction rather
--                                   than on a track. Without it, a real diversion decided late in
--                                   the approach would be erased by the clause below.
--   it was on approach when clean — the last honest fix inside 150 km and below 25,000 ft, which
--                                   is descending for this airport and nowhere else. This is the
--                                   part that says where it actually went.
--
-- The time recorded is the estimate, not a landing: nobody watched it touch down. Hence
-- arr_confirmed_at rather than real_arr, and a source of its own so that a reader — or a later
-- version of me — can tell this apart from an observation.
-- The airport list is a parameter, not a literal. Every file that wrote its own copy of it drifted
-- — DEZ opened in August and was missed in one of them — so lib/syria-airports.ts is the only
-- place it is spelled out and the caller passes it down.
create or replace function public.rebut_spoofed_diversions(p_airports text[])
returns integer language plpgsql as $function$
declare
  n integer;
begin
  with frozen as (
    -- A position held to the digit while the altitude changed. Aeroplanes do not descend in place.
    --
    -- The anchor coordinate comes back too, and that is not incidental. The first reading at the
    -- anchor still looks honest — its predecessor is a real position somewhere else, so nothing has
    -- repeated yet — and taking simply "the last fix before the freeze" therefore lands on the
    -- earliest lie rather than the last truth. Both flights measured 194 km from Damascus that way,
    -- which is the anchor's distance, not the aircraft's. Fixes at the anchor are excluded below.
    select callsign, min(observed_at) as began, min(lat) as anchor_lat, min(lon) as anchor_lon
      from (
        select callsign, observed_at, lat, lon, altitude_ft,
               lag(lat)         over w as plat,
               lag(lon)         over w as plon,
               lag(altitude_ft) over w as palt,
               lag(observed_at) over w as pat
          from fr24_live_position
         where observed_at > now() - interval '3 days'
        window w as (partition by callsign order by observed_at)
      ) s
     where lat = plat and lon = plon
       and altitude_ft is not null and palt is not null and altitude_ft <> palt
       and observed_at - pat < interval '5 minutes'
     group by callsign
  ),
  candidate as (
    select f.flight_date, f.iata_number, f.dep_iata, f.arr_iata,
           coalesce(f.est_arr, f.sched_arr) as when_arr,
           fz.began, fz.anchor_lat, fz.anchor_lon, a.lat as arr_lat, a.lon as arr_lon
      from flight f
      join frozen  fz on fz.callsign = f.callsign
      join airports a on a.iata = f.arr_iata
     where f.outcome = 'diverted'
       and f.real_arr is null
       and f.arr_confirmed_at is null
       and f.arr_iata = any (p_airports)
       and f.flight_date >= (current_date - 2)
       and coalesce(f.est_arr, f.sched_arr) is not null
  ),
  -- The last fix before the transmitter stopped telling the truth.
  clean as (
    select distinct on (c.flight_date, c.iata_number, c.dep_iata, c.arr_iata)
           c.*, p.lat, p.lon, p.altitude_ft
      from candidate c
      join flight f
        on f.flight_date = c.flight_date and f.iata_number = c.iata_number
       and f.dep_iata = c.dep_iata and f.arr_iata = c.arr_iata
      join fr24_live_position p
        on p.callsign = f.callsign
       and p.observed_at < c.began
       and (p.lat, p.lon) is distinct from (c.anchor_lat, c.anchor_lon)
     order by c.flight_date, c.iata_number, c.dep_iata, c.arr_iata, p.observed_at desc
  )
  update flight f
     set arr_confirmed_at  = c.when_arr,
         arr_confirmed_src = 'position_rebuttal',
         outcome           = 'arrived'
    from clean c
   where f.flight_date = c.flight_date and f.iata_number = c.iata_number
     and f.dep_iata = c.dep_iata and f.arr_iata = c.arr_iata
     and c.altitude_ft < 25000
     and 6371 * acos(least(1, greatest(-1,
           sin(radians(c.arr_lat)) * sin(radians(c.lat)) +
           cos(radians(c.arr_lat)) * cos(radians(c.lat)) * cos(radians(c.lon - c.arr_lon))
         ))) < 150;

  get diagnostics n = row_count;
  return n;
end
$function$;

-- The canonical flight record. Design: docs/flight-data-architecture.md
--
-- One row per flight per operating day, written by the Railway harvester and read by nothing
-- yet. fr24_daily_cache carries on untouched; readers move across one file at a time.

create table if not exists flight (
  -- Identity, resolved through airlines.icao -> iata before writing, so a flight filed as
  -- FYC781 by FR24 and sold as XH781 lands on one row rather than two.
  flight_date     date        not null,
  iata_number     text        not null,
  dep_iata        text        not null,
  arr_iata        text        not null,

  callsign        text,
  fr24_id         text,
  airline_iata    text,
  aircraft_type   text,
  registration    text,

  -- The canonical facts. Measured to agree across sources: 27 flights seen from both ends,
  -- zero disagreements on actual departure, zero on actual arrival.
  sched_dep       timestamptz not null,
  sched_arr       timestamptz not null,
  est_dep         timestamptz,
  est_arr         timestamptz,
  real_dep        timestamptz,
  real_arr        timestamptz,

  -- When we learned the value now held, not when it happened. The cache has one fetched_at per
  -- airport-day, which is why "when did RJ434's departure reach us" was answerable only to
  -- within eleven minutes.
  est_dep_seen_at  timestamptz,
  est_arr_seen_at  timestamptz,
  real_dep_seen_at timestamptz,
  real_arr_seen_at timestamptz,

  -- What became of it. 'unknown' is first-class: absence of data is not evidence a flight did
  -- not fly, and recording our own blind spots as facts would poison the stats built on this.
  outcome         text        not null default 'unknown'
                  check (outcome in ('departed','cancelled','no_show','unknown')),
  outcome_checked_at timestamptz,
  outcome_source     text,
  diverted_to     text,

  dep_terminal    text,
  dep_gate        text,
  arr_terminal    text,
  arr_gate        text,
  arr_baggage     text,

  -- Which feeds reported it. Diagnostic only; there is nothing to reconcile.
  sources         text[]      not null default '{}',

  first_seen_at   timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  primary key (flight_date, iata_number, dep_iata, arr_iata)
);

-- The board asks for departures from an airport on a day and arrivals to it on a day, and the
-- two are different questions: a flight landing after midnight belongs to the next day at its
-- arrival end and to this one at its departure end.
create index if not exists flight_dep_idx  on flight (dep_iata, sched_dep);
create index if not exists flight_arr_idx  on flight (arr_iata, sched_arr);
create index if not exists flight_date_idx on flight (flight_date);
create index if not exists flight_fr24_idx on flight (fr24_id) where fr24_id is not null;

-- No status column: it is a rendering of the timestamps from a viewpoint, not a fact. Measured
-- on 28 flights seen from both ends — the times agreed, the status strings differed 27 times.

create table if not exists flight_event (
  id            bigserial   primary key,
  flight_date   date        not null,
  iata_number   text        not null,
  dep_iata      text        not null,
  arr_iata      text        not null,
  field         text        not null,
  old_value     text,
  new_value     text,
  source        text        not null,
  observed_at   timestamptz not null default now()
);

create index if not exists flight_event_flight_idx on flight_event (flight_date, iata_number, observed_at);
create index if not exists flight_event_field_idx  on flight_event (field, observed_at desc);

create table if not exists flight_history (
  flight_date     date        not null,
  iata_number     text        not null,
  dep_iata        text        not null,
  arr_iata        text        not null,
  callsign        text,
  airline_iata    text,
  aircraft_type   text,
  registration    text,
  sched_dep       timestamptz not null,
  sched_arr       timestamptz not null,
  real_dep        timestamptz,
  real_arr        timestamptz,
  diverted_to     text,
  outcome         text        not null,
  outcome_source  text,
  -- Derived once at compaction so the stats path never recomputes them.
  dep_delay_min   int,
  arr_delay_min   int,
  compacted_at    timestamptz not null default now(),
  primary key (flight_date, iata_number, dep_iata, arr_iata)
);

create index if not exists flight_history_date_idx    on flight_history (flight_date);
create index if not exists flight_history_airline_idx on flight_history (airline_iata, flight_date);

-- Invariants live here rather than in nine call sites. Carried over from the staging trigger,
-- where they have been running since 10 Aug.
create or replace function flight_stamp() returns trigger language plpgsql as $$
begin
  new.updated_at := now();

  if tg_op = 'INSERT' then
    if new.est_dep  is not null then new.est_dep_seen_at  := now(); end if;
    if new.est_arr  is not null then new.est_arr_seen_at  := now(); end if;
    if new.real_dep is not null then new.real_dep_seen_at := now(); end if;
    if new.real_arr is not null then new.real_arr_seen_at := now(); end if;
    return new;
  end if;

  -- An event that happened does not un-happen because the feed stopped mentioning it.
  if new.real_dep is null and old.real_dep is not null then new.real_dep := old.real_dep; end if;
  if new.real_arr is null and old.real_arr is not null then new.real_arr := old.real_arr; end if;

  -- "is distinct from" rather than "<>", so a value returning to null counts as a change —
  -- which is how FR24 retires an estimate once a flight is down.
  if new.est_dep  is distinct from old.est_dep  then new.est_dep_seen_at  := now();
  else new.est_dep_seen_at  := old.est_dep_seen_at;  end if;
  if new.est_arr  is distinct from old.est_arr  then new.est_arr_seen_at  := now();
  else new.est_arr_seen_at  := old.est_arr_seen_at;  end if;
  if new.real_dep is distinct from old.real_dep then new.real_dep_seen_at := now();
  else new.real_dep_seen_at := old.real_dep_seen_at; end if;
  if new.real_arr is distinct from old.real_arr then new.real_arr_seen_at := now();
  else new.real_arr_seen_at := old.real_arr_seen_at; end if;

  return new;
end $$;

drop trigger if exists flight_stamp_trg on flight;
create trigger flight_stamp_trg before insert or update on flight
  for each row execute function flight_stamp();

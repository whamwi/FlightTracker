-- Insert on change. Measured, not assumed.
--
-- Two hours of unconditional appending produced 19,840 rows carrying 657 facts. 96.7% of every
-- write was byte-identical to the row before it. XY387 is the case in miniature: 42 rows, 11
-- distinct states, of which nine were the arrival estimate walking in — 06:06, 06:09, 06:16,
-- 06:14, 06:13, 06:10, 06:09, 06:10, 06:11 — before it landed at 06:12. The upsert this table
-- replaced would have kept one row of that. Unconditional insert kept all eleven and paid for
-- thirty-one repeats to do it.
--
-- So the rule is: a row is written only when it differs from the last thing we were told about
-- that same flight.
--
-- Compared against the PREVIOUS row, not against all history. 22 of 286 legs reverted to a state
-- they had held before — 135 events. XY387 shows one plainly: its estimate went 06:09, drifted to
-- 06:16, then came back to 06:09. A "have I ever seen this hash" test would drop the return trip
-- and render a flapping estimate as a monotonic one, which is precisely backwards: an estimate
-- that oscillates is an estimate that should be trusted less, and that is only visible if the
-- oscillation is recorded.
--
-- Keyed on fr24_row, FR24's own primary key for a schedule record. Verified over 286 legs: no
-- flight carried two of them, none spanned two airports, and no leg's scheduled time or endpoints
-- ever changed underneath one.

begin;

alter table fr24_flight_raw add column if not exists content_hash text;

create or replace function fr24_raw_insert_on_change() returns trigger
language plpgsql as $$
declare
  prev_hash text;
begin
  -- Hashed here rather than in the harvester so the rule cannot be bypassed by a writer that
  -- forgets it, and so there is exactly one definition of "the same".
  if new.content_hash is null then
    new.content_hash := md5(new.raw::text);
  end if;

  -- No identifier means no basis for comparison, so the row is kept. Dropping it would be
  -- silently discarding the one case we cannot reason about.
  if new.fr24_row is null then
    return new;
  end if;

  select content_hash into prev_hash
    from fr24_flight_raw
   where fr24_row = new.fr24_row
   order by observed_at desc, id desc
   limit 1;

  if prev_hash is not null and prev_hash = new.content_hash then
    return null;                      -- unchanged since we last looked: ignore
  end if;

  return new;
end $$;

drop trigger if exists fr24_raw_insert_on_change_trg on fr24_flight_raw;
create trigger fr24_raw_insert_on_change_trg
  before insert on fr24_flight_raw
  for each row execute function fr24_raw_insert_on_change();

comment on column fr24_flight_raw.content_hash is
  'md5 of the raw payload. A row exists only because this differed from the previous row for the same fr24_row.';


-- The cost of not writing unchanged rows: "unchanged since 06:00" and "vanished from FR24''s
-- window at 06:02" would otherwise look identical. Recording which legs each request returned
-- keeps that distinguishable for well under a kilobyte, against the ~175KB the equivalent
-- unchanged rows cost.
alter table fr24_raw_probe add column if not exists legs_seen bigint[];

comment on column fr24_raw_probe.legs_seen is
  'Every fr24_row this request returned, changed or not. Absence of a raw row means unchanged; absence from this array means no longer returned.';

commit;

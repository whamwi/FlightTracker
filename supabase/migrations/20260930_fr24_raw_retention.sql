-- Retention for the FR24 tape, which was specified and never built.
--
-- 20260811_fr24_raw.sql created fr24_flight_raw append-only and said "Retention is short;
-- flight_history is the permanent product". Neither half happened. flight_history was created by
-- 20260811_flight_canonical.sql and no code has ever written to it — 0 rows on 30 Sep, and it is
-- now abandoned. Nothing pruned the tape either.
--
-- Measured on 30 Sep 2026, 67 days after the first row:
--
--   fr24_flight_raw ...... 392,928 rows, 781 MB   (71% of the entire 1,105 MB database)
--   growth ............... ~5,900 rows/day, ~12 MB/day, ~350 MB/month, unbounded
--   older than 30 days ... 142,072 rows (36%)
--
-- Deleting old rows is safe because nothing reads them. fr24_raw_to_flight() is a TRIGGER: it
-- fires on insert and maintains the canonical `flight` row in the same transaction, so the tape
-- has already been distilled by the time a row is a second old. `flight` covers the identical
-- date range from 25 July. Only the migrations that built this table ever read it.
--
-- WHY 30 DAYS RATHER THAN TRUNCATE. The tape's remaining value is re-derivation: if a merge rule
-- in fr24_raw_to_flight() is later found wrong, the raw rows let `flight` be rebuilt instead of
-- guessed at. That has already paid off once. A month is long enough to notice a bad rule and
-- short enough to bound the table at roughly 175k rows and 350 MB, where it stops growing.
--
-- WHAT THIS DOES NOT DO. A delete does not hand disk back to the operating system. Postgres marks
-- the pages reusable inside the table, so the reported size stays near its high-water mark until
-- new rows fill it. The gain here is a bounded table, not a smaller number on the dashboard. Run
-- VACUUM FULL by hand if the space is actually needed — it takes an exclusive lock and wants
-- temporary headroom, so it is not something to schedule blindly.

begin;

create extension if not exists pg_cron;

-- ── The prune ────────────────────────────────────────────────────────────────
--
-- A PROCEDURE, not a function, and the distinction is the whole point. A plpgsql FUNCTION runs
-- inside the caller's transaction and cannot COMMIT, so batching inside one would hold every
-- batch's locks until the last batch finished — precisely the single long lock the batching
-- exists to avoid. Only a procedure may commit mid-run. This was written as a function first and
-- the error was caught before the backlog run, not after.
--
-- Each batch therefore lands on its own: the harvester gets a gap between them, and a run that is
-- interrupted keeps the work already done instead of rolling all of it back. Every run after the
-- first has a day's worth to remove and exits on its second pass, where the batching costs
-- nothing.
--
-- NOTE for anyone calling this by hand: a procedure can only COMMIT when it is NOT inside an
-- explicit transaction block. Tools that wrap every statement in BEGIN/COMMIT — including some
-- SQL consoles — will fail with "invalid transaction termination". pg_cron does not wrap, so the
-- scheduled path is unaffected; to run it manually, use a client that does not open a transaction,
-- or issue the batched DELETE directly.
create or replace procedure prune_fr24_flight_raw(
  retain_days integer default 30,
  batch_size  integer default 10000
)
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff     timestamptz := now() - make_interval(days => retain_days);
  removed    bigint := 0;
  this_batch bigint;
begin
  -- A guard, not politeness: called with retain_days => 0 through a typo this would empty the
  -- tape, and the tape is the only thing that can rebuild `flight`.
  if retain_days < 7 then
    raise exception 'prune_fr24_flight_raw: retain_days must be at least 7, got %', retain_days;
  end if;

  loop
    delete from fr24_flight_raw
    where id in (
      select id from fr24_flight_raw
      where observed_at < cutoff
      order by id
      limit batch_size
    );

    get diagnostics this_batch = row_count;
    removed := removed + this_batch;
    commit;
    exit when this_batch = 0;
  end loop;

  raise notice 'prune_fr24_flight_raw: removed % rows older than %', removed, cutoff;
end;
$$;

comment on procedure prune_fr24_flight_raw(integer, integer) is
  'Deletes fr24_flight_raw rows older than retain_days (default 30, minimum 7), in batches so the '
  'first catch-up run does not lock the table against the harvester. Safe because '
  'fr24_raw_to_flight() distils each row into `flight` on insert; nothing reads the tape after '
  'that except re-derivation. Commits per batch, so it must not be called inside an\n'
  'explicit transaction block.';

-- ── Schedule ─────────────────────────────────────────────────────────────────
--
-- 03:15 UTC — 06:15 in Damascus, after the overnight arrivals have landed and well before the
-- morning departure bank, so the deletes do not contend with the harvester's busiest hours.
--
-- Unscheduled first so re-running this migration replaces the job rather than raising, and so the
-- schedule can be changed by editing one place.
select cron.unschedule('prune-fr24-raw')
where exists (select 1 from cron.job where jobname = 'prune-fr24-raw');

select cron.schedule(
  'prune-fr24-raw',
  '15 3 * * *',
  $$call public.prune_fr24_flight_raw(30)$$
);

commit;

-- ── After applying ───────────────────────────────────────────────────────────
--
-- The first scheduled run clears the ~142k row backlog. To do it now instead, and see the count:
--
--   call prune_fr24_flight_raw(30);   -- not inside a transaction block
--
-- To confirm the job is registered and check its history:
--
--   select jobname, schedule, active from cron.job where jobname = 'prune-fr24-raw';
--   select status, return_message, start_time
--     from cron.job_run_details where jobname = 'prune-fr24-raw'
--     order by start_time desc limit 5;

-- `arrived` was never a value the column could hold, so every flight that landed still read
-- `departed` — 1,447 of them back to 25 July. FR24 is the reason: status_generic stays "departed"
-- through touchdown and it never writes "Landed". KNE378 on 13 Aug still read "Departed 17:43" in
-- the same row that carried real_arr 16:47:24, so the trigger, which read the status, never saw
-- an arrival at all.
--
-- Scoped to real_arr, meaning published-by-FR24. Assumed arrivals (arr_confirmed_at, written
-- later by landing-confirm) stay `departed` and are identified by arr_confirmed_src instead —
-- the trigger cannot see that column anyway, and keeping the two apart is what lets punctuality
-- be computed from observed times alone.
--
-- Safe to backfill: every consumer of this column tests only for 'cancelled' or 'diverted'
-- (stats, daily-stats, weekly-stats, landing-confirm, flight-api derive_status). Nothing filters
-- on 'departed', so moving 1,447 rows out of it changes no surface.
alter table flight drop constraint flight_outcome_check;
alter table flight add  constraint flight_outcome_check
  check (outcome = any (array['departed','arrived','cancelled','diverted','no_show','unknown']));

-- The function body is reproduced in full by 20260813 in the Supabase migration history; only the
-- two outcome expressions changed. Insert branch:
--     when v_diverted               then 'diverted'
--     when new.real_arr is not null then 'arrived'      -- new
--     when new.real_dep is not null then 'departed'
--     when v_cancelled              then 'cancelled'
--     else 'unknown'
-- Update branch: same order, coalescing excluded/flight, with arrival outranking departure —
-- both are true of a landed flight and the later one is the more informative. Sticky by
-- construction, because real_arr is coalesced and never returns to null.

update flight set outcome = 'arrived'
where real_arr is not null and outcome = 'departed';

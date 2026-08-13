-- One-off backfill of the historic stragglers, applying exactly the rule the cron now applies
-- going forward: departed, a revised estimate more than three hours old, no arrival ever
-- recorded, not cancelled or diverted.
--
-- The cron only looks two days back, so without this every past date kept the disagreement: the
-- board calling a flight Arrived (derive_status infers it from est_arr + 15 min) while no time
-- existed and outcome still read 'departed'. XH526 EBL->ALP on 11 Aug was the last one visible.
--
-- 180 rows, 25 Jul to 11 Aug: 136 arriving into Syria, 44 outbound.
--
-- After this the invariant holds in both directions across the table — zero rows with
-- outcome 'arrived' and no time, zero rows with a time and any other outcome. 1,448 observed,
-- 191 assumed (11.7%). Assumed ones stay separable by `real_arr is null`, and arr_confirmed_src
-- names the tier, so punctuality can still be computed from observed times alone.
update flight
   set arr_confirmed_at  = est_arr,
       arr_confirmed_src = 'fr24_estimate',
       outcome           = 'arrived'
 where real_arr is null and arr_confirmed_at is null and real_dep is not null
   and est_arr is not null and est_arr < now() - interval '3 hours'
   and outcome not in ('cancelled','diverted');

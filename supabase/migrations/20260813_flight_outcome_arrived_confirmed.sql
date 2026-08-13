-- Assumed arrivals join `arrived` too, so the column and the board agree exactly.
--
-- The earlier split (outcome tracks only FR24-published arrivals) meant a flight the board calls
-- Arrived still read `departed` for the ten assumed ones. Provenance does not need a second
-- column to carry it: arr_confirmed_src already names the tier, and `real_arr is null` separates
-- assumed from observed for punctuality work. Only the outcome is shared.
--
-- Two halves, and both are needed:
--   1. landing-confirm sets outcome itself, because the trigger fires on fr24_flight_raw and so
--      never sees a direct PATCH of `flight`.
--   2. The trigger yields to arr_confirmed_at, or the next raw row with no real_arr falls through
--      to 'departed' and undoes (1). No such row is observed today — nothing arrives more than
--      three hours past an assumption — so this closes a latent path rather than an active bug.
--      The invariant should hold by construction, not because FR24 stops publishing in time.
--
-- Verified by forcing RJ431 back to 'departed' and replaying a raw row carrying no arrival: it
-- came back 'arrived' rather than falling through.
--
-- The full function body is in the Supabase migration history; the only change is one branch
-- inserted into the UPDATE outcome expression, after real_arr and before real_dep:
--     when flight.arr_confirmed_at is not null then 'arrived'

update flight set outcome = 'arrived'
where arr_confirmed_at is not null and outcome = 'departed';

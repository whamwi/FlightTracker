-- FR24's own identifier for a schedule entry, promoted from the raw payload to a column.
--
-- Measured over 11,630 rows on 11 Aug 2026, `identification.row` is the only identifier present
-- for the whole of a flight's life:
--
--            >12h out   3-12h   <3h   departed
--   row        100%      100%   100%    100%
--   hex/reg    100%      100%   100%    100%
--   fr24_id      0%        0%     5%     90%
--   callsign     0%        9%    18%     90%
--
-- `fr24_id` — which the harvester was already extracting — is the *live instance* id and does not
-- exist until the flight is close to moving. It is the right key for joining to tracks and to the
-- route-path import, and the wrong key for identity. `row` is stable across every refresh and
-- separates legs that share a flight number on different days: J9174 carried three distinct row
-- values for three consecutive days of the same DAM-KWI service.
--
-- Nullable on purpose. This is an append-only tape and a row that arrives without an identifier
-- should still be recorded, not rejected — the count of nulls is then a fact we can observe
-- rather than data we silently dropped.

begin;

alter table fr24_flight_raw add column if not exists fr24_row bigint;

-- Backfill from the payload every existing row already carries. This is the case the `raw` column
-- was bought for: a field nobody extracted is not a field that was lost.
update fr24_flight_raw
   set fr24_row = (raw->'identification'->>'row')::bigint
 where fr24_row is null
   and raw->'identification'->>'row' is not null;

-- The per-leg chronology index. Supersedes the (flight_date, num, observed_at) index for that
-- purpose, but that one is kept: `num` is what a human searches by, and `row` is meaningless
-- outside FR24.
create index if not exists fr24_flight_raw_row_idx
  on fr24_flight_raw (fr24_row, observed_at desc);

comment on column fr24_flight_raw.fr24_row is
  'FR24 identification.row — one schedule entry, one leg, one day. Present from the moment a flight is filed and stable across refreshes, unlike fr24_id which appears only near departure. The key for following a flight through its lifecycle.';

comment on column fr24_flight_raw.fr24_id is
  'FR24 identification.id — the LIVE instance id, null on 61% of rows and absent until close to departure. Join key for tracks and route-path import. Not an identity key: use fr24_row.';

commit;

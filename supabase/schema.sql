-- FlySyria schema, generated from the live database on 30 Sep 2026.

-- The repository migrations cover only 5 of 34 tables, so this file is the

-- authoritative schema, not supabase/migrations/.

--

-- Apply this BEFORE flysyria-data.sql.

-- ── Sequences ──

CREATE SEQUENCE IF NOT EXISTS airlines_id_seq;
CREATE SEQUENCE IF NOT EXISTS airspace_poll_log_id_seq;
CREATE SEQUENCE IF NOT EXISTS alert_sent_id_seq;
CREATE SEQUENCE IF NOT EXISTS alert_shadow_id_seq;
CREATE SEQUENCE IF NOT EXISTS client_error_id_seq;
CREATE SEQUENCE IF NOT EXISTS flight_alerts_id_seq;
CREATE SEQUENCE IF NOT EXISTS flight_event_id_seq;
CREATE SEQUENCE IF NOT EXISTS flight_lookup_id_seq;
CREATE SEQUENCE IF NOT EXISTS flight_track_samples_id_seq;
CREATE SEQUENCE IF NOT EXISTS fr24_flight_raw_id_seq;
CREATE SEQUENCE IF NOT EXISTS fr24_live_position_id_seq;
CREATE SEQUENCE IF NOT EXISTS fr24_staging_probe_id_seq;
CREATE SEQUENCE IF NOT EXISTS gaca_monthly_id_seq;
CREATE SEQUENCE IF NOT EXISTS route_master_id_seq;
CREATE SEQUENCE IF NOT EXISTS route_path_samples_id_seq;
CREATE SEQUENCE IF NOT EXISTS unfiled_flights_id_seq;

-- ── Tables ──

CREATE TABLE IF NOT EXISTS aircraft_last_seen (
  hex text NOT NULL,
  callsign text,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  alt_baro double precision,
  gs double precision,
  track double precision,
  aircraft_type text,
  registration text,
  syria_airports text[] DEFAULT '{}'::text[] NOT NULL,
  seen_at timestamp with time zone DEFAULT now() NOT NULL,
  first_seen_at timestamp with time zone,
  first_lat double precision,
  first_lon double precision,
  first_alt integer,
  approach_seen_at timestamp with time zone,
  approach_lat double precision,
  approach_lon double precision,
  approach_alt integer,
  raw jsonb
);

CREATE TABLE IF NOT EXISTS aircraft_photos (
  registration text NOT NULL,
  url text,
  source text,
  needs_proxy boolean DEFAULT false NOT NULL,
  attempts integer DEFAULT 1 NOT NULL,
  resolved_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS airline_images (
  prefix text NOT NULL,
  image_url text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS airlines (
  id integer DEFAULT nextval('airlines_id_seq'::regclass) NOT NULL,
  iata text,
  icao text,
  name_en text,
  name_ar text,
  country_code text,
  country_flag text,
  created_at timestamp with time zone DEFAULT now(),
  website_url text,
  facebook_url text,
  instagram_url text
);

CREATE TABLE IF NOT EXISTS airports (
  iata text NOT NULL,
  icao text,
  name text NOT NULL,
  city text NOT NULL,
  country text NOT NULL,
  lat double precision,
  lon double precision,
  is_syrian boolean DEFAULT false NOT NULL,
  country_flag text,
  utc_offset numeric(4,1),
  city_ar text,
  name_ar text,
  country_ar text,
  timezone text
);

CREATE TABLE IF NOT EXISTS airspace_poll_log (
  id bigint DEFAULT nextval('airspace_poll_log_id_seq'::regclass) NOT NULL,
  ran_at timestamp with time zone DEFAULT now() NOT NULL,
  sweeps integer NOT NULL,
  aircraft integer NOT NULL,
  written integer NOT NULL,
  circles_ok integer NOT NULL,
  blind boolean NOT NULL,
  elapsed_ms integer NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_sent (
  id bigint DEFAULT nextval('alert_sent_id_seq'::regclass) NOT NULL,
  token text NOT NULL,
  iata_number text NOT NULL,
  flight_date date NOT NULL,
  event text NOT NULL,
  detail text,
  sent_at timestamp with time zone DEFAULT now() NOT NULL,
  ok boolean DEFAULT true NOT NULL,
  error text
);

CREATE TABLE IF NOT EXISTS alert_shadow (
  id bigint DEFAULT nextval('alert_shadow_id_seq'::regclass) NOT NULL,
  iata_number text NOT NULL,
  flight_date date NOT NULL,
  event text NOT NULL,
  detail text,
  would_send boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  context jsonb
);

CREATE TABLE IF NOT EXISTS callsign_registration (
  callsign text NOT NULL,
  registration text NOT NULL,
  source text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS client_error (
  id bigint DEFAULT nextval('client_error_id_seq'::regclass) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  platform text NOT NULL,
  release text,
  kind text DEFAULT 'ERROR'::text NOT NULL,
  message text NOT NULL,
  stack text,
  path text,
  session_id text,
  context jsonb
);

CREATE TABLE IF NOT EXISTS daily_stats (
  stat_date date NOT NULL,
  airport_iata text NOT NULL,
  arrivals integer DEFAULT 0 NOT NULL,
  departures integer DEFAULT 0 NOT NULL,
  measured integer DEFAULT 0 NOT NULL,
  on_time integer DEFAULT 0 NOT NULL,
  avg_delay_min numeric,
  median_delay_min numeric,
  cancelled integer DEFAULT 0 NOT NULL,
  diverted integer DEFAULT 0 NOT NULL,
  airlines integer DEFAULT 0 NOT NULL,
  routes integer DEFAULT 0 NOT NULL,
  computed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS dest_images (
  iata text NOT NULL,
  image_url text NOT NULL,
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flight (
  flight_date date NOT NULL,
  iata_number text NOT NULL,
  dep_iata text NOT NULL,
  arr_iata text NOT NULL,
  callsign text,
  fr24_id text,
  airline_iata text,
  aircraft_type text,
  registration text,
  sched_dep timestamp with time zone NOT NULL,
  sched_arr timestamp with time zone NOT NULL,
  est_dep timestamp with time zone,
  est_arr timestamp with time zone,
  real_dep timestamp with time zone,
  real_arr timestamp with time zone,
  est_dep_seen_at timestamp with time zone,
  est_arr_seen_at timestamp with time zone,
  real_dep_seen_at timestamp with time zone,
  real_arr_seen_at timestamp with time zone,
  outcome text DEFAULT 'unknown'::text NOT NULL,
  outcome_checked_at timestamp with time zone,
  outcome_source text,
  diverted_to text,
  dep_terminal text,
  dep_gate text,
  arr_terminal text,
  arr_gate text,
  arr_baggage text,
  sources text[] DEFAULT '{}'::text[] NOT NULL,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  arr_confirmed_at timestamp with time zone,
  arr_confirmed_src text,
  dep_provisional_since timestamp with time zone
);

CREATE TABLE IF NOT EXISTS flight_alerts (
  id bigint DEFAULT nextval('flight_alerts_id_seq'::regclass) NOT NULL,
  token text NOT NULL,
  iata_number text NOT NULL,
  flight_date date NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  events text[] DEFAULT ARRAY['DEPARTED'::text, 'LANDED'::text, 'ETA_MOVED'::text, 'CANCELLED'::text] NOT NULL,
  active boolean DEFAULT true NOT NULL
);

CREATE TABLE IF NOT EXISTS flight_event (
  id bigint DEFAULT nextval('flight_event_id_seq'::regclass) NOT NULL,
  flight_date date NOT NULL,
  iata_number text NOT NULL,
  dep_iata text NOT NULL,
  arr_iata text NOT NULL,
  field text NOT NULL,
  old_value text,
  new_value text,
  source text NOT NULL,
  observed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS flight_history (
  flight_date date NOT NULL,
  iata_number text NOT NULL,
  dep_iata text NOT NULL,
  arr_iata text NOT NULL,
  callsign text,
  airline_iata text,
  aircraft_type text,
  registration text,
  sched_dep timestamp with time zone NOT NULL,
  sched_arr timestamp with time zone NOT NULL,
  real_dep timestamp with time zone,
  real_arr timestamp with time zone,
  diverted_to text,
  outcome text NOT NULL,
  outcome_source text,
  dep_delay_min integer,
  arr_delay_min integer,
  compacted_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS flight_lookup (
  id integer DEFAULT nextval('flight_lookup_id_seq'::regclass) NOT NULL,
  airline_id integer,
  iata_number text,
  broadcast_callsign text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  source text DEFAULT 'airport'::text NOT NULL,
  fr24_id text,
  fr24_uses_callsign boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS flight_position_log (
  callsign text NOT NULL,
  flight_date date NOT NULL,
  captured_at timestamp with time zone NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  alt_baro integer,
  gs integer,
  track double precision,
  hex text,
  dep_iata text,
  arr_iata text
);

CREATE TABLE IF NOT EXISTS flight_signal_log (
  callsign text NOT NULL,
  flight_date date NOT NULL,
  hex text,
  dep_iata text,
  arr_iata text,
  first_seen_at timestamp with time zone NOT NULL,
  last_seen_at timestamp with time zone,
  actual_dep_at timestamp with time zone,
  airborne_at timestamp with time zone,
  actual_arr_at timestamp with time zone,
  real_dep_synced boolean DEFAULT false NOT NULL,
  real_arr_synced boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS flight_state_snapshot (
  iata_number text NOT NULL,
  flight_date date NOT NULL,
  status text,
  actual_dep_utc text,
  actual_arr_utc text,
  eta_utc text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  eta_baseline_utc text
);

CREATE TABLE IF NOT EXISTS flight_track_samples (
  id bigint DEFAULT nextval('flight_track_samples_id_seq'::regclass) NOT NULL,
  callsign text NOT NULL,
  operator text DEFAULT "left"(callsign, 3),
  dep_iata text NOT NULL,
  arr_iata text NOT NULL,
  flight_date date NOT NULL,
  seen_at timestamp with time zone NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  gc_fraction double precision NOT NULL,
  alt_ft integer,
  gs_kts double precision,
  track_deg double precision,
  source text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  iata_number text
);

CREATE TABLE IF NOT EXISTS fr24_daily_cache (
  airport_iata text NOT NULL,
  flight_date date NOT NULL,
  arrivals jsonb DEFAULT '[]'::jsonb NOT NULL,
  departures jsonb DEFAULT '[]'::jsonb NOT NULL,
  arr_count integer DEFAULT 0 NOT NULL,
  dep_count integer DEFAULT 0 NOT NULL,
  fetched_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS fr24_flight_raw (
  id bigint DEFAULT nextval('fr24_flight_raw_id_seq'::regclass) NOT NULL,
  observed_at timestamp with time zone DEFAULT now() NOT NULL,
  probe_uid uuid,
  source_airport text NOT NULL,
  page integer NOT NULL,
  direction text NOT NULL,
  fr24_id text,
  num text,
  callsign text,
  airline_iata text,
  airline_icao text,
  airline_name text,
  reg text,
  hex text,
  aircraft_code text,
  aircraft_text text,
  dep_iata text,
  dep_icao text,
  dep_name text,
  arr_iata text,
  arr_icao text,
  arr_name text,
  sched_dep timestamp with time zone,
  sched_arr timestamp with time zone,
  est_dep timestamp with time zone,
  est_arr timestamp with time zone,
  real_dep timestamp with time zone,
  real_arr timestamp with time zone,
  eta timestamp with time zone,
  src_updated timestamp with time zone,
  dep_terminal text,
  dep_gate text,
  arr_terminal text,
  arr_gate text,
  arr_baggage text,
  status_text text,
  status_generic text,
  status_type text,
  status_icon text,
  status_live boolean,
  flight_date date,
  raw jsonb NOT NULL,
  fr24_row bigint,
  content_hash text
);

CREATE TABLE IF NOT EXISTS fr24_live_position (
  id bigint DEFAULT nextval('fr24_live_position_id_seq'::regclass) NOT NULL,
  observed_at timestamp with time zone DEFAULT now() NOT NULL,
  fr24_id text NOT NULL,
  fr24_row bigint,
  hex text,
  callsign text,
  flight_number text,
  registration text,
  aircraft_type text,
  lat double precision,
  lon double precision,
  altitude_ft integer,
  ground_speed_kts integer,
  track_deg integer,
  vertical_speed_fpm integer,
  squawk text,
  on_ground boolean,
  source text,
  origin_iata text,
  dest_iata text,
  airline_icao text,
  fix_at timestamp with time zone,
  aircraft_seen integer,
  raw jsonb
);

CREATE TABLE IF NOT EXISTS fr24_raw_probe (
  id bigint DEFAULT nextval('fr24_staging_probe_id_seq'::regclass) NOT NULL,
  queried_at timestamp with time zone DEFAULT now() NOT NULL,
  endpoint text NOT NULL,
  fetch_by text,
  query text NOT NULL,
  page integer DEFAULT 1 NOT NULL,
  http_status integer NOT NULL,
  duration_ms integer,
  rows_returned integer,
  payload jsonb,
  probe_uid uuid,
  legs_seen bigint[]
);

CREATE TABLE IF NOT EXISTS gaca_monthly (
  id integer DEFAULT nextval('gaca_monthly_id_seq'::regclass) NOT NULL,
  month date NOT NULL,
  scope text NOT NULL,
  passengers_total integer,
  passengers_in integer,
  passengers_out integer,
  flights integer,
  airlines integer,
  overflights integer,
  source text DEFAULT 'syrgaca'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS push_devices (
  token text NOT NULL,
  platform text,
  app_version text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  disabled_at timestamp with time zone,
  locale text DEFAULT 'en'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS route_master (
  id integer DEFAULT nextval('route_master_id_seq'::regclass) NOT NULL,
  flight_id integer NOT NULL,
  dep_iata text NOT NULL,
  arr_iata text NOT NULL,
  dep_time time without time zone,
  arr_time time without time zone,
  dep_time_utc time without time zone,
  arr_time_utc time without time zone,
  duration_min integer,
  days_of_week text[],
  source text DEFAULT 'damairport'::text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  data_updated timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  airline_id integer NOT NULL
);

CREATE TABLE IF NOT EXISTS route_path_samples (
  id bigint DEFAULT nextval('route_path_samples_id_seq'::regclass) NOT NULL,
  callsign text NOT NULL,
  dep_iata text NOT NULL,
  arr_iata text NOT NULL,
  variant smallint,
  s double precision NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  off_path_km double precision NOT NULL,
  gs_kts double precision,
  alt_ft integer,
  flight_date date NOT NULL,
  seen_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS route_paths (
  dep_iata text NOT NULL,
  arr_iata text NOT NULL,
  waypoints jsonb DEFAULT '[]'::jsonb NOT NULL,
  total_dist_nm double precision,
  source_flights text[],
  updated_at timestamp with time zone DEFAULT now(),
  is_validated boolean DEFAULT false NOT NULL,
  variant smallint DEFAULT 1 NOT NULL,
  observed_count integer DEFAULT 0 NOT NULL,
  last_matched_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS route_paths_learned (
  dep_iata text NOT NULL,
  arr_iata text NOT NULL,
  operator text NOT NULL,
  waypoints jsonb NOT NULL,
  observed_count integer DEFAULT 0 NOT NULL,
  sample_count integer DEFAULT 0 NOT NULL,
  source_flights text[],
  outliers_excluded integer DEFAULT 0 NOT NULL,
  first_learned_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS syrgaca_media (
  media_id text NOT NULL,
  post_id text,
  media_type text NOT NULL,
  caption text,
  permalink text NOT NULL,
  posted_at timestamp with time zone,
  image_url text,
  thumb_url text NOT NULL,
  width integer,
  height integer,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  source text DEFAULT 'facebook'::text NOT NULL,
  video_id text,
  pinned boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS syrgaca_sync_state (
  id integer DEFAULT 1 NOT NULL,
  run_id text,
  run_started_at timestamp with time zone,
  last_synced_at timestamp with time zone,
  last_error text,
  job text
);

CREATE TABLE IF NOT EXISTS unfiled_flights (
  id integer DEFAULT nextval('unfiled_flights_id_seq'::regclass) NOT NULL,
  flight_date date NOT NULL,
  iata_number text NOT NULL,
  dep_iata text NOT NULL,
  arr_iata text NOT NULL,
  sched_dep_utc time without time zone,
  sched_arr_utc time without time zone,
  duration_min integer,
  day_of_week text,
  route_master_id integer,
  rm_dep_time_utc time without time zone,
  rm_arr_time_utc time without time zone,
  diff_minutes integer,
  reason text NOT NULL,
  reviewed boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- ── Constraints ──

ALTER TABLE aircraft_last_seen ADD CONSTRAINT aircraft_last_seen_pkey PRIMARY KEY (hex);
ALTER TABLE aircraft_photos ADD CONSTRAINT aircraft_photos_pkey PRIMARY KEY (registration);
ALTER TABLE airline_images ADD CONSTRAINT airline_images_pkey PRIMARY KEY (prefix);
ALTER TABLE airlines ADD CONSTRAINT airlines_pkey PRIMARY KEY (id);
ALTER TABLE airports ADD CONSTRAINT airports_pkey PRIMARY KEY (iata);
ALTER TABLE airspace_poll_log ADD CONSTRAINT airspace_poll_log_pkey PRIMARY KEY (id);
ALTER TABLE alert_sent ADD CONSTRAINT alert_sent_pkey PRIMARY KEY (id);
ALTER TABLE alert_shadow ADD CONSTRAINT alert_shadow_pkey PRIMARY KEY (id);
ALTER TABLE callsign_registration ADD CONSTRAINT callsign_registration_pkey PRIMARY KEY (callsign);
ALTER TABLE client_error ADD CONSTRAINT client_error_pkey PRIMARY KEY (id);
ALTER TABLE daily_stats ADD CONSTRAINT daily_stats_pkey PRIMARY KEY (stat_date, airport_iata);
ALTER TABLE dest_images ADD CONSTRAINT dest_images_pkey PRIMARY KEY (iata);
ALTER TABLE flight ADD CONSTRAINT flight_pkey PRIMARY KEY (flight_date, iata_number, dep_iata, arr_iata);
ALTER TABLE flight_alerts ADD CONSTRAINT flight_alerts_pkey PRIMARY KEY (id);
ALTER TABLE flight_event ADD CONSTRAINT flight_event_pkey PRIMARY KEY (id);
ALTER TABLE flight_history ADD CONSTRAINT flight_history_pkey PRIMARY KEY (flight_date, iata_number, dep_iata, arr_iata);
ALTER TABLE flight_lookup ADD CONSTRAINT flight_lookup_pkey PRIMARY KEY (id);
ALTER TABLE flight_position_log ADD CONSTRAINT flight_position_log_pkey PRIMARY KEY (callsign, flight_date, captured_at);
ALTER TABLE flight_signal_log ADD CONSTRAINT flight_signal_log_pkey PRIMARY KEY (callsign, flight_date);
ALTER TABLE flight_state_snapshot ADD CONSTRAINT flight_state_snapshot_pkey PRIMARY KEY (iata_number, flight_date);
ALTER TABLE flight_track_samples ADD CONSTRAINT flight_track_samples_pkey PRIMARY KEY (id);
ALTER TABLE fr24_daily_cache ADD CONSTRAINT fr24_daily_cache_pkey PRIMARY KEY (airport_iata, flight_date);
ALTER TABLE fr24_flight_raw ADD CONSTRAINT fr24_flight_raw_pkey PRIMARY KEY (id);
ALTER TABLE fr24_live_position ADD CONSTRAINT fr24_live_position_pkey PRIMARY KEY (id);
ALTER TABLE fr24_raw_probe ADD CONSTRAINT fr24_staging_probe_pkey PRIMARY KEY (id);
ALTER TABLE gaca_monthly ADD CONSTRAINT gaca_monthly_pkey PRIMARY KEY (id);
ALTER TABLE push_devices ADD CONSTRAINT push_devices_pkey PRIMARY KEY (token);
ALTER TABLE route_master ADD CONSTRAINT route_master_pkey PRIMARY KEY (id);
ALTER TABLE route_path_samples ADD CONSTRAINT route_path_samples_pkey PRIMARY KEY (id);
ALTER TABLE route_paths ADD CONSTRAINT route_paths_pkey PRIMARY KEY (dep_iata, arr_iata, variant);
ALTER TABLE route_paths_learned ADD CONSTRAINT route_paths_learned_pkey PRIMARY KEY (dep_iata, arr_iata, operator);
ALTER TABLE syrgaca_media ADD CONSTRAINT syrgaca_media_pkey PRIMARY KEY (media_id);
ALTER TABLE syrgaca_sync_state ADD CONSTRAINT syrgaca_sync_state_pkey PRIMARY KEY (id);
ALTER TABLE unfiled_flights ADD CONSTRAINT unfiled_flights_pkey PRIMARY KEY (id);
ALTER TABLE airlines ADD CONSTRAINT airlines_iata_key UNIQUE (iata);
ALTER TABLE airports ADD CONSTRAINT airports_icao_key UNIQUE (icao);
ALTER TABLE alert_sent ADD CONSTRAINT alert_sent_token_iata_number_flight_date_event_key UNIQUE (token, iata_number, flight_date, event);
ALTER TABLE flight_alerts ADD CONSTRAINT flight_alerts_token_iata_number_flight_date_key UNIQUE (token, iata_number, flight_date);
ALTER TABLE flight_lookup ADD CONSTRAINT flight_lookup_iata_number_unique UNIQUE (iata_number);
ALTER TABLE flight_track_samples ADD CONSTRAINT flight_track_samples_callsign_seen_at_key UNIQUE (callsign, seen_at);
ALTER TABLE gaca_monthly ADD CONSTRAINT gaca_monthly_month_scope_key UNIQUE (month, scope);
ALTER TABLE unfiled_flights ADD CONSTRAINT unfiled_flights_iata_number_dep_iata_arr_iata_flight_date_r_key UNIQUE (iata_number, dep_iata, arr_iata, flight_date, reason);
ALTER TABLE flight ADD CONSTRAINT flight_outcome_check CHECK ((outcome = ANY (ARRAY['departed'::text, 'arrived'::text, 'cancelled'::text, 'diverted'::text, 'no_show'::text, 'unknown'::text])));
ALTER TABLE fr24_flight_raw ADD CONSTRAINT fr24_flight_raw_direction_check CHECK ((direction = ANY (ARRAY['departure'::text, 'arrival'::text])));
ALTER TABLE syrgaca_media ADD CONSTRAINT syrgaca_media_media_type_check CHECK ((media_type = ANY (ARRAY['photo'::text, 'video'::text])));
ALTER TABLE syrgaca_media ADD CONSTRAINT syrgaca_media_source_check CHECK ((source = ANY (ARRAY['facebook'::text, 'youtube'::text, 'curated'::text])));
ALTER TABLE syrgaca_media ADD CONSTRAINT syrgaca_media_youtube_needs_video_id CHECK (((source <> ALL (ARRAY['youtube'::text, 'curated'::text])) OR (video_id IS NOT NULL)));
ALTER TABLE unfiled_flights ADD CONSTRAINT unfiled_flights_reason_check CHECK ((reason = ANY (ARRAY['time_drift'::text, 'new_route'::text, 'alias'::text, 'new_day'::text])));
ALTER TABLE flight_alerts ADD CONSTRAINT flight_alerts_token_fkey FOREIGN KEY (token) REFERENCES push_devices(token) ON DELETE CASCADE;
ALTER TABLE flight_lookup ADD CONSTRAINT flight_lookup_airline_id_fkey FOREIGN KEY (airline_id) REFERENCES airlines(id);
ALTER TABLE route_master ADD CONSTRAINT route_master_airline_id_fkey FOREIGN KEY (airline_id) REFERENCES airlines(id);
ALTER TABLE route_master ADD CONSTRAINT route_master_flight_id_fkey FOREIGN KEY (flight_id) REFERENCES flight_lookup(id) ON DELETE CASCADE;
ALTER TABLE unfiled_flights ADD CONSTRAINT unfiled_flights_route_master_id_fkey FOREIGN KEY (route_master_id) REFERENCES route_master(id) ON DELETE SET NULL;

-- ── Indexes ──

CREATE INDEX aircraft_last_seen_seen_at ON public.aircraft_last_seen USING btree (seen_at);
CREATE INDEX aircraft_photos_missing_idx ON public.aircraft_photos USING btree (resolved_at) WHERE (url IS NULL);
CREATE INDEX aircraft_photos_resolved_idx ON public.aircraft_photos USING btree (resolved_at);
CREATE INDEX airlines_iata_idx ON public.airlines USING btree (iata);
CREATE INDEX airlines_icao_idx ON public.airlines USING btree (icao);
CREATE INDEX airspace_poll_log_ran_at_idx ON public.airspace_poll_log USING btree (ran_at DESC);
CREATE INDEX alert_sent_recent ON public.alert_sent USING btree (sent_at DESC);
CREATE INDEX alert_shadow_created_idx ON public.alert_shadow USING btree (created_at DESC);
CREATE INDEX alert_shadow_event_idx ON public.alert_shadow USING btree (event, would_send);
CREATE INDEX callsign_registration_reg_idx ON public.callsign_registration USING btree (registration);
CREATE INDEX client_error_created_idx ON public.client_error USING btree (created_at DESC);
CREATE INDEX client_error_platform_idx ON public.client_error USING btree (platform, created_at DESC);
CREATE INDEX daily_stats_date_idx ON public.daily_stats USING btree (stat_date DESC);
CREATE INDEX flight_alerts_lookup ON public.flight_alerts USING btree (iata_number, flight_date) WHERE active;
CREATE INDEX flight_arr_idx ON public.flight USING btree (arr_iata, sched_arr);
CREATE INDEX flight_arr_unconfirmed_idx ON public.flight USING btree (arr_iata, flight_date) WHERE ((real_arr IS NULL) AND (arr_confirmed_at IS NULL));
CREATE INDEX flight_date_idx ON public.flight USING btree (flight_date);
CREATE INDEX flight_dep_idx ON public.flight USING btree (dep_iata, sched_dep);
CREATE INDEX flight_event_field_idx ON public.flight_event USING btree (field, observed_at DESC);
CREATE INDEX flight_event_flight_idx ON public.flight_event USING btree (flight_date, iata_number, observed_at);
CREATE INDEX flight_fr24_idx ON public.flight USING btree (fr24_id) WHERE (fr24_id IS NOT NULL);
CREATE INDEX flight_history_airline_idx ON public.flight_history USING btree (airline_iata, flight_date);
CREATE INDEX flight_history_date_idx ON public.flight_history USING btree (flight_date);
CREATE INDEX flight_lookup_airline_id_idx ON public.flight_lookup USING btree (airline_id);
CREATE INDEX flight_lookup_broadcast_callsign_idx ON public.flight_lookup USING btree (broadcast_callsign);
CREATE INDEX flight_lookup_iata_number_idx ON public.flight_lookup USING btree (iata_number);
CREATE UNIQUE INDEX flight_position_log_dedup ON public.flight_position_log USING btree (callsign, flight_date, lat, lon, COALESCE(alt_baro, '-1'::integer));
CREATE INDEX flight_track_samples_flightno_idx ON public.flight_track_samples USING btree (dep_iata, arr_iata, iata_number, gc_fraction);
CREATE INDEX flight_track_samples_route_idx ON public.flight_track_samples USING btree (dep_iata, arr_iata, operator, gc_fraction);
CREATE INDEX flight_track_samples_seen_idx ON public.flight_track_samples USING btree (seen_at DESC);
CREATE INDEX fr24_flight_raw_flight_idx ON public.fr24_flight_raw USING btree (flight_date, num, observed_at DESC);
CREATE INDEX fr24_flight_raw_observed_brin ON public.fr24_flight_raw USING brin (observed_at);
CREATE INDEX fr24_flight_raw_probe_idx ON public.fr24_flight_raw USING btree (probe_uid);
CREATE INDEX fr24_flight_raw_row_idx ON public.fr24_flight_raw USING btree (fr24_row, observed_at DESC);
CREATE UNIQUE INDEX fr24_live_position_fix_uniq ON public.fr24_live_position USING btree (fr24_id, fix_at);
CREATE INDEX fr24_live_position_flight_idx ON public.fr24_live_position USING btree (fr24_row, fix_at DESC);
CREATE INDEX fr24_live_position_observed_brin ON public.fr24_live_position USING brin (observed_at);
CREATE INDEX fr24_raw_probe_uid_idx ON public.fr24_raw_probe USING btree (probe_uid);
CREATE INDEX fr24_staging_probe_query_idx ON public.fr24_raw_probe USING btree (query, queried_at DESC);
CREATE INDEX fr24_staging_probe_time_idx ON public.fr24_raw_probe USING btree (queried_at DESC);
CREATE INDEX idx_fr24_cache_date ON public.fr24_daily_cache USING btree (flight_date DESC);
CREATE INDEX route_master_airline_id_idx ON public.route_master USING btree (airline_id);
CREATE INDEX route_master_arr_iata_idx ON public.route_master USING btree (arr_iata);
CREATE INDEX route_master_dep_iata_idx ON public.route_master USING btree (dep_iata);
CREATE INDEX route_master_flight_id_idx ON public.route_master USING btree (flight_id);
CREATE UNIQUE INDEX route_master_unique_timed ON public.route_master USING btree (flight_id, dep_iata, arr_iata, dep_time_utc) WHERE (dep_time_utc IS NOT NULL);
CREATE UNIQUE INDEX route_master_unique_untimed ON public.route_master USING btree (flight_id, dep_iata, arr_iata) WHERE (dep_time_utc IS NULL);
CREATE INDEX route_path_samples_created_idx ON public.route_path_samples USING btree (created_at);
CREATE UNIQUE INDEX route_path_samples_dedupe_idx ON public.route_path_samples USING btree (callsign, flight_date, seen_at);
CREATE INDEX route_path_samples_leg_idx ON public.route_path_samples USING btree (dep_iata, arr_iata, flight_date, callsign);
CREATE INDEX route_path_samples_od_s_idx ON public.route_path_samples USING btree (dep_iata, arr_iata, s);
CREATE INDEX route_paths_od_idx ON public.route_paths USING btree (dep_iata, arr_iata);
CREATE INDEX syrgaca_media_pinned_posted_idx ON public.syrgaca_media USING btree (pinned DESC, posted_at DESC NULLS LAST);
CREATE INDEX syrgaca_media_posted_at_idx ON public.syrgaca_media USING btree (posted_at DESC NULLS LAST);
CREATE INDEX syrgaca_media_source_idx ON public.syrgaca_media USING btree (source);
CREATE UNIQUE INDEX syrgaca_sync_state_job_key ON public.syrgaca_sync_state USING btree (job);

-- ── Functions and procedures ──

CREATE OR REPLACE FUNCTION public.expand_flight_instances(days_ahead integer DEFAULT 14)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  inserted INT;
BEGIN
  WITH day_map(abbr, dow_num) AS (
    VALUES
      ('sun', 0), ('mon', 1), ('tue', 2), ('wed', 3),
      ('thu', 4), ('fri', 5), ('sat', 6)
  ),
  dates AS (
    SELECT generate_series(
      CURRENT_DATE,
      CURRENT_DATE + (days_ahead - 1) * INTERVAL '1 day',
      '1 day'
    )::date AS d
  ),
  candidates AS (
    SELECT
      rm.id        AS route_id,
      rm.flight_id,
      rm.dep_iata,
      rm.arr_iata,
      d.d          AS flight_date,
      (d.d + rm.dep_time_utc) AT TIME ZONE 'UTC' AS std,
      CASE
        WHEN rm.arr_time_utc IS NULL THEN NULL
        WHEN rm.arr_time_utc < rm.dep_time_utc
          THEN ((d.d + 1) + rm.arr_time_utc) AT TIME ZONE 'UTC'
        ELSE (d.d + rm.arr_time_utc) AT TIME ZONE 'UTC'
      END AS sta
    FROM route_master rm
    CROSS JOIN dates d
    JOIN day_map dm ON dm.dow_num = EXTRACT(dow FROM d.d)
    WHERE dm.abbr = ANY(rm.days_of_week)
      AND rm.dep_time_utc IS NOT NULL
      AND rm.active = TRUE
  )
  INSERT INTO flight_instance (flight_id, route_id, flight_date, dep_iata, arr_iata, std, sta)
  SELECT flight_id, route_id, flight_date, dep_iata, arr_iata, std, sta
  FROM candidates
  ON CONFLICT (flight_id, flight_date, dep_iata) DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.flight_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.fr24_raw_insert_on_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.fr24_raw_to_flight()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_num       text := new.num;
  v_iata      text;
  v_callsign  text;
  v_dep       text;
  v_arr       text;
  al          record;
  v_real_dep  timestamptz;
  v_prev_real timestamptz;
  v_prov      timestamptz;
begin
  -- Not a flight: no identifier, or no schedule to hang it on.
  if v_num is null or new.sched_dep is null or new.sched_arr is null then
    return null;
  end if;

  -- Identity. FR24 files some carriers under the IATA number and some under the callsign, so the
  -- raw `num` may be either. Resolve through `airlines`, which carries both codes for every
  -- airline in the scheme.
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

  -- The codeshare filter. An unknown prefix is not a flight we show.
  if not found then
    return null;
  end if;

  -- Both identifiers, always. Whichever form FR24 omitted is derived from the airline's pair.
  if v_callsign is null and al.icao is not null then
    v_callsign := al.icao || substring(v_iata from length(al.iata) + 1);
  end if;

  -- FR24 omits the observing airport's own code. Fill it from the source.
  v_dep := coalesce(nullif(new.dep_iata, ''), new.source_airport);
  v_arr := coalesce(nullif(new.arr_iata, ''), new.source_airport);

  -- The provisional-departure guard. FR24 flushes its own estimate into the real-departure field
  -- for one sweep before the actual off-block arrives; the tell is that an estimate always lands
  -- on the exact minute and an aircraft does not. Measured 08-15 Aug: of 168 departures on :00,
  -- 113 were later corrected by more than 5 minutes, worst 74; of 291 carrying seconds, 1 was.
  -- The clock is new.observed_at, not now(), so replaying the tape reproduces the same decisions.
  select f.real_dep, f.dep_provisional_since
    into v_prev_real, v_prov
    from flight f
   where f.flight_date = new.flight_date and f.iata_number = v_iata
     and f.dep_iata = v_dep and f.arr_iata = v_arr;

  v_real_dep := new.real_dep;

  -- Only a flight still in the air is worth protecting: the guard exists so a marker does not jump
  -- down its route, and a landed flight has no marker.
  if v_real_dep is not null and new.real_arr is null and extract(second from v_real_dep) = 0 then
    if v_prev_real is not null and extract(second from v_prev_real) <> 0 then
      -- A round-minute value arriving after an observed one is the estimate coming back.
      v_real_dep := null;
    else
      v_prov := coalesce(v_prov, new.observed_at);
      if new.observed_at - v_prov < interval '5 minutes' then
        v_real_dep := null;   -- hold: est_dep still carries it, so the flight reads as expected
      end if;
    end if;
  else
    v_prov := null;
  end if;

  insert into flight (
    flight_date, iata_number, dep_iata, arr_iata,
    callsign, fr24_id, airline_iata, aircraft_type, registration,
    sched_dep, sched_arr, est_dep, est_arr, real_dep, real_arr,
    dep_provisional_since,
    dep_terminal, dep_gate, arr_terminal, arr_gate, arr_baggage,
    outcome, sources, first_seen_at, updated_at
  ) values (
    new.flight_date, v_iata, v_dep, v_arr,
    v_callsign, nullif(new.fr24_id, ''), al.iata,
    nullif(new.aircraft_code, ''), nullif(new.reg, ''),
    new.sched_dep, new.sched_arr, new.est_dep,
    case when new.real_arr is not null then null else new.est_arr end,
    v_real_dep, new.real_arr,
    v_prov,
    nullif(new.dep_terminal, ''), nullif(new.dep_gate, ''),
    nullif(new.arr_terminal, ''), nullif(new.arr_gate, ''), nullif(new.arr_baggage, ''),
    case when v_real_dep is not null then 'departed' else 'unknown' end,
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
    est_arr       = case when coalesce(excluded.real_arr, flight.real_arr) is not null
                         then null
                         else coalesce(excluded.est_arr, flight.est_arr) end,
    real_dep      = coalesce(excluded.real_dep, flight.real_dep),
    real_arr      = coalesce(excluded.real_arr, flight.real_arr),
    dep_provisional_since = excluded.dep_provisional_since,
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
end $function$
;

CREATE OR REPLACE FUNCTION public.fr24_status_rank(s text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when s is null                                                  then 0
    when lower(s) like '%cancel%'                                   then 9
    when lower(s) like '%landed%' or lower(s) like '%arrived%'      then 8
    when lower(s) like '%approach%'                                 then 7
    when lower(s) like '%en route%' or lower(s) like '%in flight%'  then 6
    when lower(s) like '%departed%' or lower(s) like '%took off%'   then 5
    when lower(s) like 'delayed%'                                   then 4
    when lower(s) like '%boarding%' or lower(s) like '%gate close%' then 3
    when lower(s) like 'estimated%' or lower(s) like 'expect%'      then 2
    when lower(s) in ('scheduled', 'scheduled*')                    then 1
    else 0
  end
$function$
;

CREATE OR REPLACE FUNCTION public.get_active_fyc_callsigns(hours_back integer DEFAULT 12)
 RETURNS TABLE(broadcast_callsign text, operating_date date)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT DISTINCT fl.broadcast_callsign,
    CASE
      WHEN (NOW() AT TIME ZONE 'UTC')::time >= rm.arr_time_utc::time
        THEN CURRENT_DATE
      ELSE CURRENT_DATE - INTERVAL '1 day'
    END::date AS operating_date
  FROM flight_lookup fl
  JOIN route_master rm ON rm.flight_id = fl.id
  WHERE fl.broadcast_callsign LIKE 'FYC%'
    AND rm.active = TRUE
    AND (
      (
        (NOW() AT TIME ZONE 'UTC')::time >= rm.arr_time_utc::time
        AND EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC')::time - rm.arr_time_utc::time)) / 3600 <= hours_back
      )
      OR
      (
        (NOW() AT TIME ZONE 'UTC')::time < rm.arr_time_utc::time
        AND (24 - EXTRACT(EPOCH FROM (rm.arr_time_utc::time - (NOW() AT TIME ZONE 'UTC')::time)) / 3600) <= hours_back
      )
      OR
      (
        rm.arr_time_utc::time > (NOW() AT TIME ZONE 'UTC')::time
        AND EXTRACT(EPOCH FROM (rm.arr_time_utc::time - (NOW() AT TIME ZONE 'UTC')::time)) / 60 <= 30
      )
    );
$function$
;

CREATE OR REPLACE FUNCTION public.get_arrival_watch_candidates()
 RETURNS TABLE(callsign text, arr_iata text, actual_dep_utc timestamp with time zone, status text, best_arr_utc timestamp with time zone, fr24_id text, lat double precision, lon double precision, alt_baro integer, seen_at timestamp with time zone)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT DISTINCT ON (fs.callsign)
    fs.callsign,
    fs.arr_iata,
    fs.actual_dep_utc,
    fs.status,
    COALESCE(
      fs.revised_arr_utc,
      fs.scheduled_arr_utc,
      CASE WHEN fsch.duration_min IS NOT NULL AND fs.actual_dep_utc IS NOT NULL
        THEN fs.actual_dep_utc + (fsch.duration_min || ' minutes')::interval
        ELSE NULL
      END
    ) AS best_arr_utc,
    fs.fr24_id,
    als.lat,
    als.lon,
    als.alt_baro,
    als.seen_at
  FROM flight_status fs
  LEFT JOIN flight_lookup fl    ON fl.broadcast_callsign = fs.callsign
  LEFT JOIN flight_schedule fsch ON fsch.flight_id = fl.id
  LEFT JOIN LATERAL (
    SELECT lat, lon, alt_baro, seen_at
    FROM aircraft_last_seen
    WHERE callsign = fs.callsign
    ORDER BY seen_at DESC
    LIMIT 1
  ) als ON true
  WHERE (fs.actual_dep_utc IS NOT NULL OR fs.status IN ('En Route', 'EnRoute', 'Departed', 'Approaching'))
    AND fs.actual_arr_utc IS NULL
    AND fs.operating_date >= (now() - interval '1 day')::date
  ORDER BY fs.callsign, fsch.duration_min DESC NULLS LAST
$function$
;

CREATE OR REPLACE FUNCTION public.get_syria_broadcast_callsigns()
 RETURNS TABLE(broadcast_callsign text)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT DISTINCT fl.broadcast_callsign
  FROM flight_lookup fl
  JOIN flight_schedule fs ON fs.flight_id = fl.id
  WHERE fs.dep_icao IN ('OSDI','OSAP')
     OR fs.arr_icao IN ('OSDI','OSAP')
     OR fs.dep_iata IN ('DAM','ALP')
     OR fs.arr_iata IN ('DAM','ALP')
  ORDER BY fl.broadcast_callsign;
$function$
;

CREATE OR REPLACE FUNCTION public.get_syria_callsigns(p_day text DEFAULT NULL::text)
 RETURNS TABLE(broadcast_callsign text, syria_airports text[], arr_time_utc text, duration_min integer, dep_syria boolean, arr_syria boolean, dest_iata text, orig_iata text)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    fl.broadcast_callsign,
    array_agg(DISTINCT ap) FILTER (WHERE ap IS NOT NULL) AS syria_airports,
    to_char(
      COALESCE(
        MIN(CASE WHEN rm.arr_iata IN ('DAM','ALP') THEN rm.arr_time_utc END),
        MIN(rm.arr_time_utc)
      ), 'HH24:MI'
    ) AS arr_time_utc,
    COALESCE(
      MIN(CASE WHEN rm.arr_iata IN ('DAM','ALP') THEN rm.duration_min END),
      MIN(rm.duration_min)
    ) AS duration_min,
    bool_or(rm.dep_iata IN ('DAM','ALP')) AS dep_syria,
    bool_or(rm.arr_iata IN ('DAM','ALP')) AS arr_syria,
    MIN(rm.arr_iata) AS dest_iata,
    MIN(rm.dep_iata) AS orig_iata
  FROM route_master rm
  JOIN flight_lookup fl ON fl.id = rm.flight_id
  CROSS JOIN LATERAL (VALUES
    (CASE WHEN rm.dep_iata IN ('DAM','ALP') THEN rm.dep_iata END),
    (CASE WHEN rm.arr_iata IN ('DAM','ALP') THEN rm.arr_iata END)
  ) AS t(ap)
  WHERE fl.broadcast_callsign IS NOT NULL
    AND (rm.dep_iata IN ('DAM','ALP') OR rm.arr_iata IN ('DAM','ALP'))
    AND (p_day IS NULL OR p_day = ANY(rm.days_of_week))
  GROUP BY fl.broadcast_callsign;
$function$
;

CREATE OR REPLACE FUNCTION public.get_syria_flight_pairs()
 RETURNS TABLE(iata_number text, broadcast_callsign text, fr24_id text)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT DISTINCT fl.iata_number, fl.broadcast_callsign, fl.fr24_id
  FROM flight_lookup fl
  JOIN route_master rm ON rm.flight_id = fl.id
  WHERE rm.dep_iata IN ('DAM','ALP')
     OR rm.arr_iata IN ('DAM','ALP')
  ORDER BY fl.iata_number;
$function$
;

CREATE OR REPLACE FUNCTION public.get_syria_iata_numbers()
 RETURNS TABLE(iata_number text)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT DISTINCT fl.iata_number
  FROM flight_lookup fl
  JOIN flight_schedule fs ON fs.flight_id = fl.id
  WHERE fs.dep_icao IN ('OSDI','OSAP')
     OR fs.arr_icao IN ('OSDI','OSAP')
     OR fs.dep_iata IN ('DAM','ALP')
     OR fs.arr_iata IN ('DAM','ALP')
  ORDER BY fl.iata_number;
$function$
;

CREATE OR REPLACE FUNCTION public.manage_flight_tracking()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Preserve first_seen_* once set — never overwrite
  IF OLD.first_seen_at IS NOT NULL THEN
    NEW.first_seen_at := OLD.first_seen_at;
    NEW.first_lat     := OLD.first_lat;
    NEW.first_lon     := OLD.first_lon;
    NEW.first_alt     := OLD.first_alt;
  END IF;

  -- approach_*: update when below 10,000 ft (final approach / landing)
  --             preserve previous value when above (don't lose approach snapshot)
  IF NEW.alt_baro IS NOT NULL AND NEW.alt_baro < 10000 THEN
    -- New observation is low-altitude — update approach snapshot
    NEW.approach_seen_at := NEW.seen_at;
    NEW.approach_lat     := NEW.lat;
    NEW.approach_lon     := NEW.lon;
    NEW.approach_alt     := NEW.alt_baro;
  ELSE
    -- Above threshold — keep last low-altitude snapshot
    NEW.approach_seen_at := OLD.approach_seen_at;
    NEW.approach_lat     := OLD.approach_lat;
    NEW.approach_lon     := OLD.approach_lon;
    NEW.approach_alt     := OLD.approach_alt;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.preserve_first_seen()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.first_seen_at IS NOT NULL THEN
    NEW.first_seen_at := OLD.first_seen_at;
    NEW.first_lat     := OLD.first_lat;
    NEW.first_lon     := OLD.first_lon;
    NEW.first_alt     := OLD.first_alt;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.prune_flight_instances(retention_days integer DEFAULT 30)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  deleted INT;
BEGIN
  DELETE FROM flight_instance
  WHERE flight_date < CURRENT_DATE - retention_days
    AND atd IS NULL AND ata IS NULL;

  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$function$
;

CREATE OR REPLACE PROCEDURE public.prune_fr24_flight_raw(IN retain_days integer DEFAULT 30, IN batch_size integer DEFAULT 10000)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $procedure$
declare
  cutoff     timestamptz := now() - make_interval(days => retain_days);
  this_batch bigint;
  removed    bigint := 0;
begin
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

    -- Each batch lands on its own. The harvester gets a gap between them, and an
    -- interrupted run leaves the work already done rather than rolling it all back.
    commit;
    exit when this_batch = 0;
  end loop;

  raise notice 'prune_fr24_flight_raw: removed % rows older than %', removed, cutoff;
end;
$procedure$
;

CREATE OR REPLACE FUNCTION public.rebut_spoofed_diversions(p_airports text[])
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare
  n integer;
begin
  with frozen as (
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
    select f.flight_date, f.iata_number, f.callsign, f.dep_iata, f.arr_iata,
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
  clean as (
    select distinct on (c.flight_date, c.iata_number, c.dep_iata, c.arr_iata)
           c.*, p.lat, p.lon, p.altitude_ft
      from candidate c
      join fr24_live_position p
        on p.callsign = c.callsign
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
$function$
;

-- ── Triggers ──

CREATE TRIGGER flight_stamp_trg BEFORE INSERT OR UPDATE ON public.flight FOR EACH ROW EXECUTE FUNCTION flight_stamp();
CREATE TRIGGER fr24_raw_insert_on_change_trg BEFORE INSERT ON public.fr24_flight_raw FOR EACH ROW EXECUTE FUNCTION fr24_raw_insert_on_change();
CREATE TRIGGER fr24_raw_to_flight_trg AFTER INSERT OR UPDATE ON public.fr24_flight_raw FOR EACH ROW EXECUTE FUNCTION fr24_raw_to_flight();
CREATE TRIGGER trg_manage_flight_tracking BEFORE UPDATE ON public.aircraft_last_seen FOR EACH ROW EXECUTE FUNCTION manage_flight_tracking();
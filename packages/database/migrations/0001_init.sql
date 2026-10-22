-- Silva Signage Network — initial schema (Milestone 1)
-- Conventions: UUID primary keys, timestamptz stored in UTC, snake_case,
-- soft delete via deleted_at where records are user-managed.
-- Every tenant-owned row carries company_id so the API can scope queries.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
CREATE TYPE platform_role AS ENUM ('SUPER_ADMIN', 'NETWORK_OPERATOR', 'NONE');
CREATE TYPE company_role AS ENUM ('OWNER', 'STAFF');
CREATE TYPE account_status AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING');
CREATE TYPE category_rule_kind AS ENUM ('ALLOW', 'BLOCK');
CREATE TYPE screen_status AS ENUM ('ACTIVE', 'DISABLED', 'UNPAIRED');
CREATE TYPE playback_state AS ENUM ('UNKNOWN', 'PLAYING', 'IDLE_FALLBACK', 'STALLED', 'ERROR');
CREATE TYPE pairing_status AS ENUM ('PENDING', 'CLAIMED', 'DELIVERED', 'EXPIRED', 'CANCELLED');
CREATE TYPE screen_command_type AS ENUM ('REFRESH_PLAYLIST', 'REFRESH_CONFIG', 'RELOAD_PLAYER', 'REPORT_DIAGNOSTICS', 'UNPAIR');
CREATE TYPE screen_command_status AS ENUM ('PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'FAILED', 'EXPIRED');
CREATE TYPE subscription_status AS ENUM ('INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID');
-- STRIPE = state mirrored from verified provider webhooks.
-- MANUAL = set by a Silva admin (e.g. pilot or development entitlements). Never counted as revenue.
CREATE TYPE subscription_source AS ENUM ('STRIPE', 'MANUAL');
CREATE TYPE campaign_status AS ENUM (
  'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED',
  'SCHEDULED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'
);
CREATE TYPE review_decision AS ENUM ('START_REVIEW', 'APPROVE', 'REJECT', 'REQUEST_CHANGES', 'PAUSE', 'RESUME', 'CANCEL');
CREATE TYPE media_kind AS ENUM ('IMAGE', 'VIDEO');
CREATE TYPE media_status AS ENUM ('PROCESSING', 'READY', 'REJECTED');
CREATE TYPE playback_event_type AS ENUM ('SCHEDULED', 'STARTED', 'COMPLETED', 'FAILED');
CREATE TYPE actor_type AS ENUM ('USER', 'DEVICE', 'SYSTEM', 'PROVIDER');

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL,
  password_hash    text NOT NULL,
  full_name        text NOT NULL,
  platform_role    platform_role NOT NULL DEFAULT 'NONE',
  status           account_status NOT NULL DEFAULT 'ACTIVE',
  totp_secret_enc  text,                       -- encrypted with APP_SECRET-derived key
  totp_enabled     boolean NOT NULL DEFAULT false,
  failed_logins    integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_active_uq ON users (email) WHERE deleted_at IS NULL;

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,         -- sha256 of the opaque cookie token
  mfa_verified  boolean NOT NULL DEFAULT false,
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
CREATE TABLE business_categories (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug   text NOT NULL UNIQUE,
  name   text NOT NULL
);

CREATE TABLE companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  trading_name    text,
  contact_name    text,
  email           text NOT NULL,
  phone           text,
  address         text,
  eircode         text,
  website         text,
  category_id     uuid REFERENCES business_categories(id),
  status          account_status NOT NULL DEFAULT 'ACTIVE',
  -- Explicit flag so development fixtures can never be mistaken for real customers.
  is_dev_fixture  boolean NOT NULL DEFAULT false,
  stripe_customer_id text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX companies_category_idx ON companies (category_id);

CREATE TABLE user_company_memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role        company_role NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, company_id)
);
CREATE INDEX memberships_company_idx ON user_company_memberships (company_id);

-- ---------------------------------------------------------------------------
-- Locations and geography
-- ---------------------------------------------------------------------------
CREATE TABLE geographic_zones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  city        text NOT NULL DEFAULT 'Dublin',
  country     char(2) NOT NULL DEFAULT 'IE',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  name                  text NOT NULL,
  street_address        text NOT NULL,
  eircode               text,
  city                  text NOT NULL DEFAULT 'Dublin',
  neighbourhood         text,
  latitude              numeric(9,6),
  longitude             numeric(9,6),
  -- Coordinates are only stored once verified; never inferred.
  coordinates_verified  boolean NOT NULL DEFAULT false,
  category_id           uuid REFERENCES business_categories(id),
  timezone              text NOT NULL DEFAULT 'Europe/Dublin',
  -- {"mon":[{"open":"09:00","close":"18:00"}], ...}; null = no restriction recorded
  opening_hours         jsonb,
  participates_in_network boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CONSTRAINT locations_coords_need_verification CHECK (
    (latitude IS NULL AND longitude IS NULL) OR coordinates_verified
  )
);
CREATE INDEX locations_company_idx ON locations (company_id) WHERE deleted_at IS NULL;

CREATE TABLE location_zones (
  location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  zone_id      uuid NOT NULL REFERENCES geographic_zones(id) ON DELETE CASCADE,
  PRIMARY KEY (location_id, zone_id)
);
CREATE INDEX location_zones_zone_idx ON location_zones (zone_id);

-- Competition rules set by the host establishment (reviewable by Silva).
-- ALLOW rules: if any exist, only those advertiser categories may play here.
-- BLOCK rules: always win over ALLOW.
CREATE TABLE location_category_rules (
  location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  category_id  uuid NOT NULL REFERENCES business_categories(id),
  kind         category_rule_kind NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, category_id)
);

CREATE TABLE location_advertiser_exclusions (
  location_id            uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  excluded_company_id    uuid NOT NULL REFERENCES companies(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, excluded_company_id)
);

-- ---------------------------------------------------------------------------
-- Screens and devices
-- ---------------------------------------------------------------------------
CREATE TABLE screens (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL REFERENCES companies(id),
  location_id               uuid NOT NULL REFERENCES locations(id),
  display_name              text NOT NULL,
  status                    screen_status NOT NULL DEFAULT 'ACTIVE',
  platform                  text,          -- as reported by the player (e.g. "Tizen", "webOS")
  user_agent                text,
  screen_width              integer,
  screen_height             integer,
  supports_video            boolean,       -- capability reported by the player
  player_version            text,
  registered_at             timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at         timestamptz,
  last_playlist_sync_at     timestamptz,
  current_playlist_version  integer,
  playback_state            playback_state NOT NULL DEFAULT 'UNKNOWN',
  last_error                text,
  last_error_at             timestamptz,
  last_playback_at          timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz
);
CREATE INDEX screens_company_idx ON screens (company_id) WHERE deleted_at IS NULL;
CREATE INDEX screens_location_idx ON screens (location_id) WHERE deleted_at IS NULL;

-- Screens belong to the same company as their location.
CREATE FUNCTION screens_company_matches_location() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = NEW.location_id AND l.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'screen company_id must match its location company_id';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER screens_company_location_check BEFORE INSERT OR UPDATE OF company_id, location_id ON screens
  FOR EACH ROW EXECUTE FUNCTION screens_company_matches_location();

CREATE TABLE device_pairing_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash           bytea NOT NULL,     -- HMAC(APP_SECRET, normalised code)
  poll_secret_hash    bytea NOT NULL,     -- sha256 of the secret only the TV knows
  status              pairing_status NOT NULL DEFAULT 'PENDING',
  expires_at          timestamptz NOT NULL,
  claimed_by_user_id  uuid REFERENCES users(id),
  claimed_at          timestamptz,
  screen_id           uuid REFERENCES screens(id),
  delivered_at        timestamptz,
  requester_ip        inet,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- A code may only be live once at a time.
CREATE UNIQUE INDEX pairing_live_code_uq ON device_pairing_sessions (code_hash) WHERE status = 'PENDING';
CREATE INDEX pairing_expires_idx ON device_pairing_sessions (expires_at) WHERE status = 'PENDING';

CREATE TABLE device_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  screen_id     uuid NOT NULL REFERENCES screens(id),
  token_hash    bytea NOT NULL UNIQUE,     -- sha256 of the bearer token
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_reason text
);
CREATE INDEX device_credentials_screen_idx ON device_credentials (screen_id) WHERE revoked_at IS NULL;

CREATE TABLE screen_heartbeats (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  screen_id         uuid NOT NULL REFERENCES screens(id),
  received_at       timestamptz NOT NULL DEFAULT now(),
  playback_state    playback_state NOT NULL,
  playlist_version  integer,
  error             text,
  details           jsonb
);
CREATE INDEX screen_heartbeats_screen_time_idx ON screen_heartbeats (screen_id, received_at DESC);

CREATE TABLE screen_commands (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  screen_id        uuid NOT NULL REFERENCES screens(id),
  type             screen_command_type NOT NULL,
  status           screen_command_status NOT NULL DEFAULT 'PENDING',
  idempotency_key  text NOT NULL,
  issued_by        uuid REFERENCES users(id),
  result           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  delivered_at     timestamptz,
  acknowledged_at  timestamptz,
  UNIQUE (screen_id, idempotency_key)
);
CREATE INDEX screen_commands_pending_idx ON screen_commands (screen_id) WHERE status IN ('PENDING', 'DELIVERED');

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE subscription_plans (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL UNIQUE,
  name                 text NOT NULL,
  monthly_price_cents  integer NOT NULL CHECK (monthly_price_cents >= 0),
  currency             char(3) NOT NULL DEFAULT 'EUR',
  -- true while prices are draft examples, not approved commercial pricing.
  price_is_draft       boolean NOT NULL DEFAULT true,
  stripe_price_id      text UNIQUE,
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_entitlements (
  plan_id  uuid NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  key      text NOT NULL CHECK (key IN (
             'max_screens', 'max_active_campaigns', 'max_target_zones',
             'monthly_playback_allocation', 'max_campaign_days', 'distribution_weight',
             'reporting_level')),
  value    integer NOT NULL CHECK (value >= 0),
  PRIMARY KEY (plan_id, key)
);

CREATE TABLE subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL REFERENCES companies(id),
  plan_id                 uuid NOT NULL REFERENCES subscription_plans(id),
  status                  subscription_status NOT NULL,
  source                  subscription_source NOT NULL,
  stripe_subscription_id  text UNIQUE,
  current_period_start    timestamptz NOT NULL,
  current_period_end      timestamptz NOT NULL,
  cancel_at_period_end    boolean NOT NULL DEFAULT false,
  note                    text,
  created_by              uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_stripe_has_id CHECK (source <> 'STRIPE' OR stripe_subscription_id IS NOT NULL),
  CONSTRAINT subscriptions_period_order CHECK (current_period_end > current_period_start)
);
-- At most one live subscription per company.
CREATE UNIQUE INDEX subscriptions_one_live_per_company ON subscriptions (company_id)
  WHERE status IN ('INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE');

-- Verified provider events; provider_event_id makes webhook processing idempotent.
CREATE TABLE billing_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text NOT NULL DEFAULT 'stripe',
  provider_event_id  text NOT NULL,
  type               text NOT NULL,
  company_id         uuid REFERENCES companies(id),
  amount_cents       integer,
  currency           char(3),
  payload            jsonb NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  processing_error   text,
  UNIQUE (provider, provider_event_id)
);

-- ---------------------------------------------------------------------------
-- Media and campaigns
-- ---------------------------------------------------------------------------
CREATE TABLE media_assets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  kind               media_kind NOT NULL,
  status             media_status NOT NULL DEFAULT 'PROCESSING',
  rejection_reason   text,
  original_filename  text,
  detected_mime      text NOT NULL,           -- from file signature, not extension
  size_bytes         bigint NOT NULL CHECK (size_bytes > 0),
  sha256             bytea NOT NULL,
  width              integer,
  height             integer,
  duration_ms        integer,
  video_codec        text,
  storage_key        text NOT NULL UNIQUE,    -- delivery rendition
  original_storage_key text,
  thumbnail_key      text,
  uploaded_by        uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX media_assets_company_idx ON media_assets (company_id) WHERE deleted_at IS NULL;

CREATE TABLE campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),   -- the advertiser
  name                  text NOT NULL,
  description           text,
  status                campaign_status NOT NULL DEFAULT 'DRAFT',
  start_at              timestamptz NOT NULL,
  end_at                timestamptz NOT NULL,
  priority              smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  requested_plays_per_day integer CHECK (requested_plays_per_day > 0),
  -- {"days":[1,2,3,4,5],"startMinute":540,"endMinute":1080} in Europe/Dublin local time; null = any time
  schedule              jsonb,
  status_before_pause   campaign_status,
  created_by            uuid REFERENCES users(id),
  submitted_at          timestamptz,
  reviewed_by           uuid REFERENCES users(id),
  reviewed_at           timestamptz,
  review_note           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CONSTRAINT campaigns_dates_order CHECK (end_at > start_at)
);
CREATE INDEX campaigns_company_idx ON campaigns (company_id) WHERE deleted_at IS NULL;
CREATE INDEX campaigns_live_idx ON campaigns (status, start_at, end_at) WHERE deleted_at IS NULL;

CREATE TABLE campaign_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id),
  reviewer_id  uuid NOT NULL REFERENCES users(id),
  decision     review_decision NOT NULL,
  from_status  campaign_status NOT NULL,
  to_status    campaign_status NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaign_reviews_campaign_idx ON campaign_reviews (campaign_id, created_at);

CREATE TABLE campaign_media (
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  media_asset_id   uuid NOT NULL REFERENCES media_assets(id),
  position         smallint NOT NULL DEFAULT 0,
  display_seconds  smallint NOT NULL DEFAULT 15 CHECK (display_seconds BETWEEN 5 AND 60),
  PRIMARY KEY (campaign_id, media_asset_id)
);

-- Target zones. No rows = no geographic restriction.
CREATE TABLE campaign_targeting (
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  zone_id      uuid NOT NULL REFERENCES geographic_zones(id),
  PRIMARY KEY (campaign_id, zone_id)
);

-- Venue categories the advertiser wants (no rows = any) / does not want.
CREATE TABLE campaign_target_categories (
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  category_id  uuid NOT NULL REFERENCES business_categories(id),
  PRIMARY KEY (campaign_id, category_id)
);
CREATE TABLE campaign_exclusions (
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  category_id  uuid NOT NULL REFERENCES business_categories(id),
  PRIMARY KEY (campaign_id, category_id)
);

-- ---------------------------------------------------------------------------
-- Distribution and playback
-- ---------------------------------------------------------------------------
CREATE TABLE screen_playlists (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  screen_id     uuid NOT NULL REFERENCES screens(id),
  version       integer NOT NULL,
  checksum      text NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  valid_until   timestamptz NOT NULL,
  -- Engine decisions for transparency ("why is/isn't campaign X here?")
  decisions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (screen_id, version)
);
CREATE INDEX screen_playlists_latest_idx ON screen_playlists (screen_id, version DESC);

CREATE TABLE playlist_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id     uuid NOT NULL REFERENCES screen_playlists(id) ON DELETE CASCADE,
  position        smallint NOT NULL,
  campaign_id     uuid REFERENCES campaigns(id),
  media_asset_id  uuid REFERENCES media_assets(id),
  duration_sec    smallint NOT NULL,
  not_after       timestamptz,          -- player must not show this item after this instant
  is_fallback     boolean NOT NULL DEFAULT false,
  UNIQUE (playlist_id, position),
  CONSTRAINT playlist_items_ad_has_refs CHECK (is_fallback OR (campaign_id IS NOT NULL AND media_asset_id IS NOT NULL))
);
CREATE INDEX playlist_items_campaign_idx ON playlist_items (campaign_id);

CREATE TABLE delivery_allocations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id        uuid NOT NULL REFERENCES screen_playlists(id) ON DELETE CASCADE,
  campaign_id        uuid NOT NULL REFERENCES campaigns(id),
  screen_id          uuid NOT NULL REFERENCES screens(id),
  slots_per_loop     smallint NOT NULL,
  loop_seconds       integer NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (playlist_id, campaign_id)
);
CREATE INDEX delivery_allocations_campaign_idx ON delivery_allocations (campaign_id, created_at);

-- id is generated by the player, so retries are idempotent (ON CONFLICT DO NOTHING).
CREATE TABLE playback_events (
  id                uuid PRIMARY KEY,
  screen_id         uuid NOT NULL REFERENCES screens(id),
  campaign_id       uuid REFERENCES campaigns(id),
  advertiser_company_id uuid REFERENCES companies(id),
  media_asset_id    uuid REFERENCES media_assets(id),
  playlist_version  integer NOT NULL,
  type              playback_event_type NOT NULL,
  occurred_at       timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  error             text
);
CREATE INDEX playback_events_campaign_idx ON playback_events (campaign_id, occurred_at);
CREATE INDEX playback_events_screen_idx ON playback_events (screen_id, occurred_at);
CREATE INDEX playback_events_advertiser_month_idx ON playback_events (advertiser_company_id, type, occurred_at);

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type   actor_type NOT NULL,
  actor_id     uuid,
  company_id   uuid REFERENCES companies(id),
  action       text NOT NULL,
  entity_type  text,
  entity_id    uuid,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_time_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_company_idx ON audit_logs (company_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

-- Audit logs are append-only.
CREATE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id),   -- null = Silva operations
  user_id     uuid REFERENCES users(id),
  type        text NOT NULL,
  message     text NOT NULL,
  entity_type text,
  entity_id   uuid,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_company_idx ON notifications (company_id, created_at DESC);

CREATE TABLE platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

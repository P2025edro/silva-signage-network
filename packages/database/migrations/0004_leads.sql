-- Sales enquiries from the public website. Only what is needed to call the business back;
-- no IP address or tracking data is stored.
CREATE TYPE lead_status AS ENUM ('NEW', 'CONTACTED', 'DEMO_BOOKED', 'WON', 'LOST');

CREATE TABLE leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name    text NOT NULL,
  contact_name     text NOT NULL,
  email            text NOT NULL,
  phone            text,
  area             text,
  business_type    text,
  screens_estimate smallint CHECK (screens_estimate BETWEEN 0 AND 100),
  interested_plan  text,
  message          text,
  source           text NOT NULL DEFAULT 'website',
  consent_at       timestamptz NOT NULL,
  status           lead_status NOT NULL DEFAULT 'NEW',
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_status_idx ON leads (status, created_at DESC);

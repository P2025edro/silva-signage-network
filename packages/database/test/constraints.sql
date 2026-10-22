-- Database-level integrity checks. Runs inside a transaction that is rolled back.
-- Usage: psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/test/constraints.sql
\set QUIET on
\o /dev/null
BEGIN;

CREATE TEMP TABLE results (name text, passed boolean);

CREATE FUNCTION pg_temp.expect_error(test_name text, stmt text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    INSERT INTO results VALUES (test_name, false);
  EXCEPTION WHEN others THEN
    INSERT INTO results VALUES (test_name, true);
  END;
END $$ LANGUAGE plpgsql;

INSERT INTO companies (id, name, email, is_dev_fixture) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'DEV FIXTURE Company A', 'a@example.invalid', true),
  ('00000000-0000-0000-0000-00000000000b', 'DEV FIXTURE Company B', 'b@example.invalid', true);
INSERT INTO locations (id, company_id, name, street_address) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'Loc A', '1 Test St'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'Loc B', '2 Test St');

SELECT pg_temp.expect_error('screen company must match location company',
  $q$INSERT INTO screens (company_id, location_id, display_name)
     VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000b1', 'x')$q$);

INSERT INTO screens (company_id, location_id, display_name)
  VALUES ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'ok');
INSERT INTO results VALUES ('screen with matching company inserts', true);

SELECT pg_temp.expect_error('unverified coordinates rejected',
  $q$INSERT INTO locations (company_id, name, street_address, latitude, longitude)
     VALUES ('00000000-0000-0000-0000-00000000000a', 'c', 'c', 53.33, -6.26)$q$);

INSERT INTO audit_logs (actor_type, action) VALUES ('SYSTEM', 'test');
SELECT pg_temp.expect_error('audit log update blocked', $q$UPDATE audit_logs SET action = 'tampered'$q$);
SELECT pg_temp.expect_error('audit log delete blocked', $q$DELETE FROM audit_logs$q$);

INSERT INTO subscriptions (company_id, plan_id, status, source, current_period_start, current_period_end)
  SELECT '00000000-0000-0000-0000-00000000000a', id, 'ACTIVE', 'MANUAL', now(), now() + interval '30 days'
  FROM subscription_plans WHERE code = 'starter';
SELECT pg_temp.expect_error('only one live subscription per company',
  $q$INSERT INTO subscriptions (company_id, plan_id, status, source, current_period_start, current_period_end)
     SELECT '00000000-0000-0000-0000-00000000000a', id, 'ACTIVE', 'MANUAL', now(), now() + interval '30 days'
     FROM subscription_plans WHERE code = 'business'$q$);
SELECT pg_temp.expect_error('stripe subscription requires provider id',
  $q$INSERT INTO subscriptions (company_id, plan_id, status, source, current_period_start, current_period_end)
     SELECT '00000000-0000-0000-0000-00000000000b', id, 'ACTIVE', 'STRIPE', now(), now() + interval '30 days'
     FROM subscription_plans WHERE code = 'business'$q$);

SELECT pg_temp.expect_error('campaign end must follow start',
  $q$INSERT INTO campaigns (company_id, name, start_at, end_at)
     VALUES ('00000000-0000-0000-0000-00000000000a', 'bad', now(), now() - interval '1 day')$q$);

INSERT INTO device_pairing_sessions (code_hash, poll_secret_hash, expires_at)
  VALUES ('\x01', '\x02', now() + interval '10 min');
SELECT pg_temp.expect_error('duplicate live pairing code rejected',
  $q$INSERT INTO device_pairing_sessions (code_hash, poll_secret_hash, expires_at)
     VALUES ('\x01', '\x03', now() + interval '10 min')$q$);

SELECT pg_temp.expect_error('uppercase email rejected',
  $q$INSERT INTO users (email, password_hash, full_name) VALUES ('Bad@Example.com', 'x', 'x')$q$);

\o
\set QUIET off
SELECT CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result, name FROM results;
SELECT bool_or(NOT passed) AS failures FROM results \gset
ROLLBACK;
\if :failures
  \echo 'Constraint tests FAILED'
  \q 1
\else
  \echo 'All constraint tests passed'
\endif

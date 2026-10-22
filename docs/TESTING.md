# Testing

## Commands

```bash
pnpm test:unit          # engine + workflow (node:test, no database)
pnpm test:db            # database constraint tests against TEST_DATABASE_URL (rolled back)
pnpm test:integration   # API against a real PostgreSQL test database (TEST_DATABASE_URL, must end in _test)
pnpm test               # all three
pnpm test:e2e           # Playwright: recreates silva_signage_e2e, starts API + web + player, runs the browser flow
pnpm typecheck && pnpm lint
```

Integration tests truncate tables, so `apps/api/test/helpers.ts` refuses any database whose name doesn't end in `_test`. The E2E reset script refuses anything not ending in `_e2e`. Video tests need `ffmpeg`/`ffprobe` on PATH. E2E needs Playwright's Chromium (`npx playwright install chromium`).

## What is covered

| Suite | Tests | Covers |
|---|---|---|
| Unit — `packages/shared/test` | 44 | Eligibility (every reason), host competition rules and conflict resolution, own-screen policy, quotas, subscription states, media compatibility, allocation proportionality, anti-monopoly cap, displacement order, determinism, loop compression, creative rotation, playlist validity windows, Dublin time incl. both DST nights, overnight opening hours, schedule validation, capacity/shortfall, campaign state machine |
| DB — `packages/database/test/constraints.sql` | 10 | Screen/location tenant match, unverified coordinates, append-only audit log, one live subscription, Stripe id requirement, date order, single live pairing code, lowercase emails |
| Integration — `apps/api/test` | 41 | Full cross-business flow; single-use pairing; self-approval refused; signed URL tampering; playlist caching; idempotent and forged playback events; heartbeats + idempotent commands; pause/resume; host category block; scheduler completion; credential revocation; audit trail; tenant isolation (10 read endpoints + writes + media theft + cross-tenant pairing); admin-only routes; staff and operator limits; device-token scope; lockout; MFA enrolment + per-session verification; CSRF; logout revocation; entitlements (campaigns, length, zones, screens, no subscription); manual subs not revenue; upload sniffing, size, transcoding, length; Stripe signature, idempotency, payment-failure notice, billing-not-configured |
| E2E — `tests/e2e` | 5 | The brief's scenario through the real UI: admin creates Company A and B with subscriptions → A adds a location, uploads an image, creates and submits a campaign → admin approves → B adds a location, a browser opens the TV player, B pairs it with the on-screen code → the TV displays A's advert (1920px image verified, screenshot saved) → playback events reach A's report → B gets 404 for A's data and 403 for admin APIs |

## Latest results (22 Oct 2026, this environment)

| Suite | Result |
|---|---|
| Unit | 44 / 44 passed |
| DB constraints | 10 / 10 passed |
| Integration | 41 / 41 passed |
| E2E (Chromium 141 headless) | 5 / 5 passed, two consecutive runs |
| TypeScript strict | 4 / 4 packages clean |
| ESLint | 75 files, 0 errors, 0 warnings |
| Builds | web and player build |

## Not covered yet

- Real Smart TV hardware (see `SMART_TV_PLAYER.md` checklist). A desktop browser test does **not** prove TV compatibility.
- Offline playback in an automated test (implemented, manually reasoned, not exercised).
- S3 storage driver against a real bucket.
- Live Stripe Checkout / Billing Portal (only webhooks are tested, with locally signed events).
- Load/performance tests (heartbeat and event ingestion at hundreds of screens).
- Web app component tests; accessibility audit with a screen reader.

# Status — 22 Oct 2026

## Blocker

The build environment cannot reach the npm registry (outbound connection to `registry.npmjs.org` refused by network policy). The specified stack — Fastify, Vite, a PostgreSQL driver, Drizzle, TanStack Query, React Hook Form, Stripe SDK — can't be installed, so the API, web app and TV player cannot be built or tested here yet. **Fix:** allow npm (package managers) for this Claude account in claude.ai → Settings → Capabilities, or run the build on a machine with normal npm access.

## Done and verified

| Item | Verification |
|---|---|
| Monorepo skeleton, env template, docker-compose (Postgres + MinIO) | Files present; compose not run here (no image pulls) |
| Full schema: 33 tables incl. tenancy, devices, pairing, plans/entitlements, subscriptions, billing events, campaigns, media, playlists, allocations, playback, audit, settings | Applied to real PostgreSQL 16 (dev + test DBs) |
| Reference data: business categories, 7 configurable Dublin zones, 3 draft plans (flagged `price_is_draft`), platform settings | Applied |
| Migration runner (checksummed, transactional, idempotent) | Ran twice: second run no-op |
| DB integrity tests (10): screen/location company match, unverified coordinates rejected, append-only audit log, one live subscription per company, Stripe subscriptions need provider id, date ordering, single live pairing code, lowercase emails | **10/10 pass** |
| Distribution engine: eligibility, competition rules, allocation, anti-monopoly cap, playlist versioning, capacity/shortfall | **44/44 unit tests pass**, strict typecheck clean |
| Campaign approval state machine | Included in the 44 tests |
| Dublin time handling incl. both DST transition nights | Included in the 44 tests |

## Not started (requires npm access)

API (auth, MFA, RBAC, pairing, upload validation, playlists, playback ingestion, OpenAPI), web dashboard and portal, TV player, integration tests, Playwright E2E, seed/demo, Stripe.

## Commands that work now

```bash
DATABASE_URL=postgres://silva:silva_dev@localhost:5432/silva_signage pnpm db:migrate
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/test/constraints.sql
pnpm test:unit      # tsx --test packages/shared/test/*.test.ts
pnpm typecheck
```

# Silva Signage Network — Architecture

Owner: Silva Solutions Ltd, Dublin. Status: Milestone 1 in progress (see `docs/STATUS.md`).

## 1. System overview

```
 Business owner / staff ──► Web app (React)  ──┐
 Silva admin / operator ──► /admin routes      │  HTTPS, session cookie
                                               ▼
                                         API (Fastify, Node 22)
 Smart TV browser ──► TV player (vanilla TS) ──► /device/* (bearer device token)
                                               │
              ┌────────────────────────────────┼───────────────────────┐
              ▼                                ▼                       ▼
        PostgreSQL 16                  Object storage (S3)       Workers (same codebase,
  (tenants, campaigns, playlists,      media + thumbnails,       separate process):
   playback events, audit)             signed delivery URLs      scheduler, monitor
```

The **distribution engine** (`packages/shared/src/engine`) is pure TypeScript with no I/O. The API loads a snapshot (screen context + candidate campaigns), the engine decides, the API persists versioned playlists. This keeps the core business logic deterministic and unit-testable.

## 2. Technology decisions

| Area | Choice | Why |
|---|---|---|
| API framework | **Fastify** (over NestJS) | Small surface, first-class schema validation and OpenAPI generation, low overhead for high-frequency device heartbeats. NestJS's DI/module layer adds ceremony a team of this size doesn't need yet. |
| Database access | **Hand-written SQL migrations** + typed query layer (Drizzle ORM planned for queries) | Migrations stay reviewable SQL with DB-level guarantees (triggers, partial unique indexes, CHECKs) that ORMs express poorly. Runner: `packages/database/scripts/migrate.sh` (checksummed, transactional, refuses edited migrations). |
| Tests | **node:test** via `tsx` | Built into Node; no framework lock-in. Playwright for browser E2E. |
| Web app | React + Vite + Tailwind + TanStack Query + React Hook Form + Zod | As specified. |
| TV player | **Vanilla TypeScript**, bundled with esbuild, no framework | TV browsers (Tizen, webOS) are memory-constrained and often run older engines. A dependency-free player is smaller and easier to make compatible. |
| Storage | S3-compatible driver + local-disk driver for development | Same interface; MinIO in docker-compose for S3 testing. |

### Structure refinements vs. the brief

- `apps/admin-web` and `apps/client-portal` → **one app, `apps/web`**, with `/admin/*` and `/portal/*` route trees. Same components, one auth flow, one deploy. Access is enforced by the API, not the routing; splitting into two deploys later is mechanical.
- `packages/ui` → components live in `apps/web/src/components/ui` while there is a single consumer.
- `workers/*` → `apps/api/src/workers/*` with a separate entry point (`node dist/worker.js`). They share the API's database code; they run as a separate process in production because Vercel serverless is not suitable for long-running schedulers.

## 3. Tenancy and access control

- Every tenant-owned table has `company_id`. API handlers resolve the caller's memberships from the session and **scope every query by company** server-side; IDs from the client are never trusted on their own.
- Platform roles: `SUPER_ADMIN`, `NETWORK_OPERATOR`. Company roles: `OWNER`, `STAFF`.
  - Operators: review campaigns, monitor screens, manage media — no billing configuration, plans or platform settings.
  - Staff: view company data, create/edit draft campaigns, upload media. Owners additionally submit campaigns, pair screens, manage locations, users and billing.
- Super admins must complete TOTP MFA per session. `ALLOW_ADMIN_WITHOUT_MFA` exists only for local development.
- Devices authenticate with a per-screen bearer token (stored as SHA-256 hash), scoped to that screen's playlist, media and commands. Unpairing revokes it.

## 4. Device pairing

1. Unpaired player calls `POST /device/pairing-sessions` → receives a session id, a one-time **poll secret**, and an 8-character code (`XXXX-XXXX`, unambiguous alphabet, ~1.3×10¹² combinations) valid for 10 minutes.
2. An authorised user enters the code in the portal and chooses the establishment. The API checks role, company ownership of the location, and `max_screens` entitlement, then creates the screen inside a transaction.
3. The player polls with its poll secret. On the first poll after claim, it receives the device token once (status → `DELIVERED`). Codes are stored as HMAC hashes, single-use, rate-limited per user and IP.

## 5. Distribution engine

See `docs/CAMPAIGN_ENGINE.md` for the full policy. In short: eligibility (state, dates, Dublin-local schedule, subscription, quota, own-screen policy, zones, venue categories, host competition rules, media compatibility) → selection (least-delivered first) → proportional allocation (Sainte-Laguë on plan weight × priority) with an anti-monopoly cap → even interleaving. Playlists are versioned per screen and regenerated on campaign changes and at every quarter hour.

## 6. Time handling

All timestamps are stored as `timestamptz` (UTC). Schedules and opening hours are evaluated in `Europe/Dublin` via the IANA database (`Intl`), so daylight-saving changes are handled; tests cover both transition nights. Schedule edges are restricted to 15-minute steps, matching playlist regeneration.

## 7. Offline behaviour (player)

The player caches the latest playlist and media (Cache Storage / IndexedDB where available) and queues playback events in IndexedDB. Cached content is bounded: each item carries `notAfter` (campaign end), and a cached playlist is only used for `devices.offline_cache_max_hours` (24 h default) after its last successful sync. Pause/revocation takes effect on the next successful sync; it cannot reach a TV that is offline. Real-device behaviour must be verified per model (see `KNOWN_LIMITATIONS.md`).

## 8. Implementation plan

| Phase | Scope | State |
|---|---|---|
| 1 Foundation | Monorepo, schema, auth, roles, tenancy, admin dashboard, companies, establishments | Schema done and tested; app layer blocked (see STATUS) |
| 2 TV player | Player, pairing, device auth, heartbeats, playback, monitoring | Designed; not started |
| 3 Campaigns | Media upload + validation, campaigns, approval workflow, scheduling, targeting | Workflow state machine done and tested |
| 4 Network | Eligibility, cross-business distribution, allocation, playback tracking, quotas, exclusions | Engine done and tested; persistence pending |
| 5 Subscriptions | Plans, entitlements, Stripe Checkout, webhooks | Plans/entitlements in schema |
| 6 Analytics | Reports, health, CSV | Not started |
| 7 Production prep | Security review, perf, deploy, monitoring, TV compatibility testing | Not started |

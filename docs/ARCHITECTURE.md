# Architecture

Silva Signage Network — Silva Solutions Ltd, Dublin. Milestone 1 (see `STATUS.md`).

## 1. System overview

```
 Business owner / staff ─┐
                         ├─► Web app (React, apps/web) ──► /api/*  (session cookie, CSRF origin check)
 Silva admin / operator ─┘          /admin/*  /portal/*            │
                                                                  ▼
 Smart TV browser ──► TV player (vanilla TS, apps/tv-player) ──► /api/device/*  (per-screen bearer token)
                                                                  │
                                          API (Fastify, Node 22, apps/api)
                         ┌────────────────────────┼─────────────────────────┐
                         ▼                        ▼                         ▼
                 PostgreSQL 16            Object storage             Worker process
          (tenants, campaigns,         (local disk in dev,      (campaign scheduler, playlist
           playlists, events, audit)    S3-compatible in prod;    refresh, retention) — same
                                        signed URLs only)         codebase, src/worker.ts
```

The **distribution engine** (`packages/shared/src/engine`) is pure TypeScript: no I/O, clock or randomness. The API loads a snapshot (screen contexts + candidate campaigns), the engine decides, the API persists versioned playlists. Core business rules are therefore deterministic and unit-tested in isolation.

## 2. Repository layout

```
apps/api            Fastify API, workers, seed script, integration tests (node:test)
apps/web            React admin dashboard (/admin) and client portal (/portal)
apps/tv-player      Dependency-free Smart TV player (esbuild → 14 KB script)
packages/database   SQL migrations, migration runner, DB constraint tests
packages/shared     Distribution engine, campaign workflow, shared types, unit tests
tests/e2e           Playwright end-to-end test across web app, API and player
docs/               This documentation
```

Deviations from the brief's suggested layout, and why:

- **`admin-web` + `client-portal` → one app, `apps/web`.** Same components, one auth flow, one deployment. The API enforces every permission, so the split is presentation only and can be done later mechanically.
- **`packages/ui`, `packages/config` → not created.** One UI consumer today; components live in `apps/web/src/components`. Shared TS config is `tsconfig.base.json`.
- **`workers/*` → `apps/api/src/workers`.** Workers share the API's data access. They run as a **separate process** in production (`pnpm --filter @silva/api worker`), because serverless functions are not suitable for schedulers.

## 3. Technology decisions

| Area | Choice | Reason |
|---|---|---|
| API framework | **Fastify 5** (not NestJS) | Small surface, schema-first validation, OpenAPI generation, low overhead for frequent device heartbeats. NestJS's DI/module layer adds ceremony a small team doesn't need yet. |
| Validation / OpenAPI | Zod 4 + `fastify-type-provider-zod` | One schema validates requests, types handlers, and generates `/api/docs`. |
| Database access | **Hand-written SQL migrations + `postgres` (postgres.js) tagged queries** — no ORM | The brief offered Prisma or Drizzle. We chose plain SQL because the schema relies on things ORMs express poorly (partial unique indexes, triggers enforcing tenant consistency and append-only audit logs, CHECKs). postgres.js parameterises every interpolation, so queries are injection-safe. Adding Drizzle later for typed queries is possible without changing the schema. |
| Passwords | scrypt (N=2¹⁷, r=8, p=1) via Node crypto | OWASP-recommended parameters, no native dependency. |
| MFA | TOTP (RFC 6238), secrets AES-256-GCM encrypted at rest | Works with standard authenticator apps. |
| Media | sharp (images), ffprobe/ffmpeg (video) | Re-encode everything for delivery: strips metadata, normalises to 1080p JPEG / H.264. |
| Web app | React 19, Vite, Tailwind 4, TanStack Query, React Hook Form, Zod | As specified. shadcn/ui-style components are written in-repo (`components/ui`). |
| TV player | Vanilla TypeScript, esbuild, target Chromium 53 | TV browsers are memory-constrained and old. No framework, no polyfill-heavy APIs. |
| Tests | node:test (unit + integration), Playwright (E2E) | Built into Node; real Postgres for integration. |

## 4. Tenancy and access control

- Every tenant-owned row carries `company_id`. Company routes are `/api/companies/:companyId/...`; `requireCompany()` checks membership **and** every query filters by `company_id`, so an ID from another tenant is "not found" (404, never 403, so IDs can't be probed).
- Database triggers add a second line: a screen's company must match its location's company.
- Roles: platform `SUPER_ADMIN` / `NETWORK_OPERATOR`; company `OWNER` / `STAFF`.

| Capability | Super admin | Operator | Owner | Staff |
|---|---|---|---|---|
| Companies, plans, manual subscriptions, settings, audit log | ✓ | — | — | — |
| Review / approve / pause campaigns, screen commands | ✓ | ✓ | — | — |
| View any company's data | ✓ | ✓ (read-only) | own | own |
| Submit, pause, cancel own campaigns; pair/unpair screens; locations; team; billing | ✓ | — | ✓ | — |
| Create/edit draft campaigns, upload media | ✓ | — | ✓ | ✓ |

- Super admins must complete TOTP each session; `ALLOW_ADMIN_WITHOUT_MFA` exists only for local development and is refused when `NODE_ENV=production`.
- Devices authenticate with a per-screen bearer token (SHA-256 hashed at rest). It reaches only that screen's config, playlist, signed media and commands. Unpairing revokes it.

## 5. Device pairing

1. Unpaired player → `POST /api/device/pairing-sessions` → session id, one-time **poll secret**, 8-character code (`XXXX-XXXX`, 31-letter unambiguous alphabet ≈ 8.5×10¹¹ codes), valid 10 minutes.
2. An owner enters the code in the portal and picks the establishment. In one transaction the API checks role, location ownership, active subscription and `max_screens`, creates the screen and claims the session.
3. The player's next poll (authenticated by the poll secret) receives the device token exactly once (`DELIVERED`). Codes are stored as HMAC hashes, single-use, rate-limited (10/min per IP), and a code can't be live twice.

## 6. Distribution

See `CAMPAIGN_ENGINE.md`. Playlists are regenerated: on campaign actions, rule/plan/subscription/settings changes, by the scheduler when a playlist's `validUntil` passes (at most every quarter hour), and on demand when a device fetches an expired playlist.

## 7. Time

All timestamps are `timestamptz` (UTC). Schedules and opening hours are evaluated in the location's time zone (default `Europe/Dublin`) via the IANA database; tests cover both daylight-saving transition nights. Schedule edges are in 15-minute steps, aligned with playlist regeneration.

## 8. Scaling path

The MVP regenerates all playlists in one pass (fine for hundreds of screens). For thousands: regenerate only screens affected by a change (zone/category index), shard the scheduler by screen id, move playback ingestion to a queue, and partition `playback_events` by month. The engine's pure interface does not change.

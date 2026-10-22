# Silva Signage Network

Indoor digital advertising network for participating businesses in Dublin — a product of **Silva Solutions Ltd**.

Businesses subscribe, show network adverts on Smart TVs in their premises, and have their own adverts distributed to other participating establishments, subject to Silva approval, targeting, competition rules and subscription entitlements.

> **Current state:** Milestone 1 is partly built. Database schema and the distribution engine are done and tested; the API, web app and TV player are blocked on npm access. See [`docs/STATUS.md`](docs/STATUS.md).

## Layout

```
apps/api          Fastify API + workers (pending)
apps/web          Admin dashboard (/admin) and client portal (/portal) (pending)
apps/tv-player    Dependency-free Smart TV web player (pending)
packages/database SQL migrations, migration runner, DB integrity tests
packages/shared   Distribution engine, campaign workflow, shared types
docs/             Architecture, engine policy, status
```

## Local setup

Requirements: Node 22+, pnpm, PostgreSQL 16 (or `docker compose up -d`).

```bash
cp .env.example .env
export DATABASE_URL=postgres://silva:silva_dev@localhost:5432/silva_signage
export TEST_DATABASE_URL=postgres://silva:silva_dev@localhost:5432/silva_signage_test
pnpm install
pnpm db:migrate && pnpm db:migrate:test
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/test/constraints.sql
pnpm test:unit
```

## Documentation

- [Architecture and plan](docs/ARCHITECTURE.md)
- [Distribution engine policy](docs/CAMPAIGN_ENGINE.md)
- [Status and blockers](docs/STATUS.md)

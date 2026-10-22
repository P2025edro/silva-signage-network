# Silva Signage Network

An indoor digital advertising network for participating businesses in Dublin — by **Silva Solutions Ltd**.

Businesses subscribe, install Smart TVs in their premises, and have their adverts distributed to other participating establishments. Silva Solutions approves every advert and controls the network.

**Status:** Milestone 1 complete and tested locally; not deployed. See [`docs/STATUS.md`](docs/STATUS.md).

## What's here

| Path | What |
|---|---|
| `apps/api` | Fastify API, campaign scheduler/maintenance worker, seed script, integration tests |
| `apps/web` | Admin dashboard (`/admin`) and business portal (`/portal`) — React, Vite, Tailwind |
| `apps/tv-player` | Smart TV web player (vanilla TypeScript, ~14 KB) |
| `packages/database` | SQL migrations, migration runner, constraint tests |
| `packages/shared` | Distribution engine and campaign workflow (pure, unit-tested) |
| `tests/e2e` | Playwright test of the full cross-business flow |
| `docs/` | Architecture, schema, API, player, engine, security, deployment, testing, manuals, limitations |

## Requirements

Node 22+, pnpm 10, PostgreSQL 16, ffmpeg/ffprobe (video processing), and for E2E Playwright's Chromium.

## Run it locally

```bash
# 1. Database (or: docker compose up -d)
createuser -d silva -P                 # password: silva_dev
createdb -O silva silva_signage && createdb -O silva silva_signage_test

# 2. Configure
cp .env.example .env                   # then set APP_SECRET:  openssl rand -base64 48
                                        # for local use also set ALLOW_ADMIN_WITHOUT_MFA=true and RUN_WORKERS_IN_PROCESS=true
pnpm install

# 3. Schema and demo data
set -a; . ./.env; set +a
pnpm db:migrate
SEED_ADMIN_PASSWORD='choose-a-long-password' pnpm db:seed --demo   # prints sign-ins once

# 4. Start everything (API :4000, web :5173, TV player :5174)
pnpm dev:api                                                       # terminal 1
pnpm dev:web                                                       # terminal 2
PLAYER_API_URL=http://localhost:4000 PLAYER_PORTAL_URL=localhost:5173 pnpm dev:player   # terminal 3
```

- **Admin dashboard:** http://localhost:5173 → sign in as `admin@silvasolutions.dev.invalid` with the password you chose.
- **Business portal:** same address, signing in as a fixture owner (`owner-a@dev-fixture.invalid`, `owner-b@dev-fixture.invalid`; passwords printed by the seed).
- **TV player:** http://localhost:5174 (any browser; on a real TV use the TV's browser and a reachable address).
- **API reference:** http://localhost:4000/api/docs

## Try cross-business advertising

The `--demo` seed creates two clearly labelled fictional businesses, each with a location, an advert image, a draft campaign and a manual (non-revenue) subscription.

1. **Pair a screen for Company B:** open the TV player — it shows a code. Sign in as Company B's owner → *Establishments & screens* → *Pair a screen* → enter the code. The TV shows the Silva holding slide.
2. **Submit Company A's advert:** sign in as Company A's owner → *Campaigns* → open the draft → *Submit for approval*.
3. **Approve it:** sign in as the admin → *Campaigns* → open it → *Approve*.
4. **Watch:** within about a minute (or immediately via *Smart TVs* → *Refresh playlist*), the TV shows Company A's advert. Company B's own advert never appears on its own screen.
5. **Check reporting:** Company A → *Reports* shows playback starts by location. Admin → *Advertising network* explains why each campaign is or isn't on each screen.

## Tests

```bash
pnpm test        # unit (44) + database constraints (10) + API integration (41)
pnpm test:e2e    # browser end-to-end (5)
pnpm typecheck && pnpm lint
```

Results and coverage: [`docs/TESTING.md`](docs/TESTING.md).

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Database](docs/DATABASE_SCHEMA.md) · [API](docs/API_DOCUMENTATION.md) · [TV player](docs/SMART_TV_PLAYER.md) · [Campaign engine](docs/CAMPAIGN_ENGINE.md) · [Security & compliance](docs/SECURITY.md) · [Deployment](docs/DEPLOYMENT.md) · [Testing](docs/TESTING.md) · [Admin manual](docs/ADMIN_MANUAL.md) · [Client manual](docs/CLIENT_MANUAL.md) · [Known limitations](docs/KNOWN_LIMITATIONS.md)

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid configuration: APP_SECRET` | Set a 32+ character `APP_SECRET` in `.env` |
| Admin pages say two-factor is required | Enrol under Settings, or for local only set `ALLOW_ADMIN_WITHOUT_MFA=true` |
| `CSRF_REJECTED` | The web app's origin must be in `WEB_ORIGINS` |
| Video upload rejected with "could not be read" | Install ffmpeg (`ffprobe` must be on PATH) |
| TV stuck on "Can't reach Silva Signage Network" | The player can't reach the API: check `PLAYER_API_URL` / `?api=` and that the TV can reach that host |
| Campaign approved but not on a screen | Admin → Advertising network → click the screen to see the reason (zones, rules, subscription, own screen, opening hours) |
| Integration tests refuse to run | `TEST_DATABASE_URL` must point at a database whose name ends in `_test` |

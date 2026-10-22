# API

Base path `/api`. JSON in and out. Interactive OpenAPI reference: **`/api/docs`** (development) and `/api/docs/json`.

## Authentication

| Client | Mechanism |
|---|---|
| People (web app) | `ssn_session` cookie (HttpOnly, SameSite=Lax, Secure in production). State-changing requests must carry an `Origin` in `WEB_ORIGINS`. |
| Smart TVs | `Authorization: Bearer <device token>` on `/api/device/*`. |
| Stripe | `Stripe-Signature` on `/api/billing/stripe/webhook`. |

Errors: `{ "error": { "code": "…", "message": "…", "details"? } }`. Common codes: `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `DEVICE_NOT_PAIRED` (401), `FORBIDDEN` / `MFA_REQUIRED` / `MFA_ENROLLMENT_REQUIRED` / `CSRF_REJECTED` (403), `NOT_FOUND` (404 — also returned for other tenants' resources), `ENTITLEMENT_EXCEEDED` (402), `INVALID_TRANSITION` (409), `MEDIA_REJECTED` (422), `ACCOUNT_LOCKED` (429), `BILLING_NOT_CONFIGURED` (503).

## Endpoints

### Auth
`POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/mfa/verify` · `POST /auth/mfa/setup` · `POST /auth/mfa/enable` · `POST /auth/password`

### Company-scoped (`/companies/:companyId`)
| Method | Path | Min. role |
|---|---|---|
| GET / PATCH | `` | view / owner |
| GET / POST / DELETE | `/users[/:userId]` | view / owner |
| GET | `/notifications` | view |
| GET / POST | `/locations` | view / owner |
| PUT / DELETE | `/locations/:id` | owner |
| PUT | `/locations/:id/rules` | owner |
| GET | `/screens`, `/screens/:id`, `/screens/:id/playlist` | view |
| POST | `/screens/pair` | owner |
| PATCH | `/screens/:id` (rename) | owner |
| POST | `/screens/:id/unpair`, `/screens/:id/commands` | owner |
| GET / POST | `/media` (multipart `file`) | view / staff |
| DELETE | `/media/:id` | staff |
| GET / POST | `/campaigns` | view / staff |
| GET / PUT / DELETE | `/campaigns/:id` | view / staff (drafts only) |
| POST | `/campaigns/:id/actions` `{action, reason?}` | depends on action |
| GET | `/campaigns/:id/report`, `/campaigns/:id/report.csv` | view |
| GET | `/billing` | view |
| POST | `/billing/checkout`, `/billing/portal` | owner |

Campaign actions: `SUBMIT` (owner), `START_REVIEW` / `APPROVE` / `REJECT` / `REQUEST_CHANGES` (Silva), `PAUSE` / `RESUME` / `CANCEL` (owner or Silva).

### Reference
`GET /categories` · `GET /zones` · `GET /plans`

### Admin (`/admin`, Silva staff)
`GET /overview` · `GET /alerts` · `GET|POST /companies` · `POST /companies/:id/status` · `POST /companies/:id/subscriptions/manual` · `GET /subscriptions` · `POST /subscriptions/:id/cancel` · `PUT /plans/:id` · `GET /billing` · `GET /locations` · `GET /screens` · `POST /screens/:id/commands|status|unpair` · `GET /campaigns[/:id]` · `POST /campaigns/:id/priority` · `GET /network/summary` · `GET /network/screens/:id/playlist` · `POST /network/regenerate` · `GET|POST|PUT /zones` · `GET /analytics` · `GET /analytics/playback.csv` · `GET /audit-logs` · `GET|PUT /settings[/:key]` · `GET|POST /users`

### Device (`/device`, bearer token unless noted)
| Method | Path | Notes |
|---|---|---|
| POST | `/pairing-sessions` | no auth; 10/min/IP |
| GET | `/pairing-sessions/:id` | `X-Poll-Secret`; returns token once |
| GET | `/config` | heartbeat interval, offline limits |
| GET | `/playlist?knownVersion=n` | `{unchanged:true}` if current; items include signed media URLs and `notAfter` |
| POST | `/heartbeat` | state, playlist version, capabilities; returns pending commands |
| POST | `/commands/:id/ack` | |
| POST | `/playback-events` | ≤200 events; idempotent by event id; events for campaigns not in that screen's playlist version are rejected |

`GET /media-files/*?exp&sig` serves media for the local storage driver (HMAC-signed, expiring, supports HTTP Range).

### Health
`GET /health` — checks the database.

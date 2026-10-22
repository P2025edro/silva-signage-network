# Status — Milestone 1 (22 Oct 2026)

Milestone 1 is implemented and verified in a development environment. The defining scenario runs end to end through the real UI, API, database and TV player: **Company A uploads an advert, Silva approves it, and it plays on Company B's paired screen**, with playback reported back to A. It is ready for local demonstration and for planning a controlled pilot; it is **not** production-ready (see `KNOWN_LIMITATIONS.md`).

## Acceptance criteria (brief §20)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Silva admin signs in securely | ✅ | scrypt, sessions, MFA enforced for super admins — `security.test.ts`, E2E |
| 2 | Admin creates two independent companies | ✅ | E2E step 1 |
| 3 | Each company manages its own profile | ✅ | `PATCH /companies/:id` (owner-only), portal Settings |
| 4 | Two establishments registered | ✅ | E2E steps 2 and 4 |
| 5 | Two TV players paired independently | ✅ | `network-flow.test.ts` (A and B screens); E2E pairs via the real player |
| 6 | Each player receives its own authorised configuration | ✅ | `/device/config` per token; device-scope test |
| 7 | Customer uploads a valid advert | ✅ | E2E upload; validation tests |
| 8 | Campaign enters the approval workflow | ✅ | E2E submit; state machine tests |
| 9 | Admin approves | ✅ | E2E approve |
| 10 | Engine finds an eligible screen of another company | ✅ | integration + engine tests (`OWN_SCREEN` excluded) |
| 11 | Advert appears on that screen | ✅ | E2E: TV displays the 1920×1080 advert (screenshot) |
| 12 | Playback events recorded | ✅ | E2E report shows starts; idempotency/forgery tests |
| 13 | Admin monitors device status | ✅ | heartbeat → health states; Smart TVs page |
| 14 | No cross-tenant access | ✅ | 10 endpoints + writes tested; E2E 404s |
| 15 | Entitlements restrict distribution | ✅ | screens, campaigns, length, zones, quota, subscription tests |
| 16 | Expired and paused campaigns leave new playlists | ✅ | integration + engine tests |
| 17 | Critical backend operations tested | ✅ | 44 unit, 10 DB, 41 integration, 5 E2E — all passing |
| 18 | Runs locally from documented instructions | ✅ | `README.md` |
| 19 | Production configuration documented | ✅ | `DEPLOYMENT.md` (not deployed) |
| 20 | Hardware limits and unimplemented features listed | ✅ | `KNOWN_LIMITATIONS.md` |

## Beyond Milestone 1 already in place

Stripe webhook processing (verified, idempotent) and plan management; admin analytics with CSV; alerts; audit log viewer; geographic zones; host competition rules and advertiser exclusions; campaign capacity/shortfall; campaign scheduler and retention worker; dark mode.

## Blockers / needs from Silva Solutions

1. **Real TVs** to test (one Samsung, one LG, one Android TV) — required before claiming compatibility.
2. **Hosting decisions and accounts** (API host, managed Postgres in the EU, S3 bucket, domains `app.` / `api.` / `player.silvasolutions.ie`). Nothing purchased or deployed.
3. **Stripe account**, approved prices (current €29/€59/€99 are draft examples), VAT advice.
4. **Contracts and policies**: establishment agreement, advertiser terms, privacy notice, retention policy (`SECURITY.md` checklist).

## Suggested next steps

Password reset and invitation emails → TV hardware testing → deploy a staging environment → Stripe test-mode end-to-end → pilot with 2–3 Dublin businesses.

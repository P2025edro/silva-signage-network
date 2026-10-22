# Security, privacy and compliance

Guided by OWASP ASVS / Top 10. **Nothing here has been independently audited or penetration-tested**, and no legal or GDPR compliance is certified.

## Controls in place

| Area | Control | Where |
|---|---|---|
| Passwords | scrypt N=2¹⁷ r=8 p=1, 12-character minimum; uniform timing for unknown emails; 5 failures → 15-minute lock | `lib/crypto.ts`, `routes/auth.ts` |
| Sessions | Random 256-bit token, only its SHA-256 stored; HttpOnly, SameSite=Lax, Secure in production; 12 h absolute / 2 h idle; server-side revocation on logout and password change | `auth/session.ts` |
| MFA | TOTP mandatory for super admins (enrolment forced), per-session verification; secrets AES-256-GCM encrypted with a key derived from `APP_SECRET` | `routes/auth.ts`, `lib/totp.ts` |
| CSRF | Cookie-authenticated non-GET requests must send an allowed `Origin`; device and webhook routes don't use cookies | `auth/session.ts` |
| Authorisation | Server-side role checks on every route; tenant scoping in SQL; other tenants' IDs return 404 | `requireCompany`, `requireSilva` |
| Tenant integrity | DB triggers/constraints (screen ↔ location company), partial unique indexes | migrations |
| Input | Zod schemas on every body/query/param; parameterised SQL only | routes |
| Uploads | Type from file signature (not extension/MIME); size, dimension, duration limits; images re-encoded (metadata stripped); video probed and transcoded; private storage with expiring HMAC/presigned URLs; path-traversal-safe keys | `lib/media.ts`, `lib/storage.ts` |
| Devices | Per-screen bearer token (hashed), revocable; pairing codes HMAC-hashed, single-use, 10-minute expiry, rate-limited; poll secret required to collect a token | `routes/device.ts` |
| Forged / replayed events | Events must reference a campaign+media in that screen's playlist version; client UUIDs make retries idempotent; timestamps bounded (−7 days … +5 minutes) | `routes/device.ts` |
| Entitlement bypass | Plan limits enforced in transactions at submit/pair time and in the engine (quota, subscription status) | `routes/campaigns.ts`, `routes/screens.ts`, engine |
| Rate limiting | Global 600/min/IP; tighter on login, MFA, pairing, uploads, events | route `config.rateLimit` |
| Headers | Helmet (HSTS, nosniff, X-Frame-Options, Referrer-Policy); CORS allow-list for the web app | `app.ts` |
| Errors | Generic 500 messages; details only in logs; cookies/authorization redacted from logs | `app.ts` |
| Audit | Append-only `audit_logs` (DB trigger) for auth, tenant, device, campaign, billing and settings actions | `lib/audit.ts` |
| Billing | Stripe signature verification on raw body; idempotent by event id; card data never touches our systems (Stripe Checkout / Portal) | `routes/billing.ts` |
| Secrets | Only via environment variables; production refuses placeholder `APP_SECRET` and `ALLOW_ADMIN_WITHOUT_MFA` | `config.ts` |

## Tests covering security

`apps/api/test/security.test.ts`: cross-tenant reads/writes (10 endpoints), staff/operator boundaries, device-token scope, lockout, MFA enrolment and per-session verification, CSRF, logout revocation. `network-flow.test.ts`: forged playback events, signed URL tampering, single-use pairing codes, credential revocation. `entitlements-media-billing.test.ts`: disguised uploads, webhook signature forgery, idempotency.

## Still to do before production

- Independent penetration test; dependency scanning in CI (`pnpm audit`, Dependabot/Renovate).
- Rotate device credentials periodically (revocation exists; scheduled rotation does not).
- Content-Security-Policy for the web app at the hosting layer.
- Secret management in the host (not `.env` files); key rotation procedure for `APP_SECRET` (rotating it invalidates TOTP secrets and signed URLs — needs a re-encryption step).
- Malware scanning of uploads (re-encoding removes most payload risks but is not antivirus).
- Centralised log retention and alerting.

## Privacy (GDPR) design

- **No viewer data.** No cameras, facial recognition, audience measurement, device IDs of passers-by, or profiling. Playback events record which screen played which advert and when — nothing about people.
- Personal data held: business contacts and user accounts (name, email, phone), IP addresses in sessions and audit logs.
- Data minimisation: original upload files are not kept (only re-encoded renditions); EXIF/GPS stripped.
- Retention implemented: heartbeats 30 days, old sessions 30 days, pairing sessions 7 days. **Decide and implement** retention for audit logs, playback events and billing events (accounting rules may require ~6 years for billing records).
- Still needed: privacy notice, data-processing terms with businesses, user data export and account deletion flows (soft delete exists; a full erasure procedure does not), records of processing, DPA with sub-processors (hosting, Stripe, storage).

## Compliance checklist (for the business, not certified by this software)

- [ ] Contract with each participating establishment: screen placement, content they agree to show, competition rules, liability, termination, electricity/internet responsibility.
- [ ] Advertiser terms: they hold rights to all images, video, music, fonts and trademarks; Silva may refuse or remove content.
- [ ] Review process aligned with the **ASAI Code** (Advertising Standards Authority of Ireland) — the admin review screen shows a checklist reminder.
- [ ] Sector rules: alcohol (Public Health (Alcohol) Act 2018 restrictions), gambling, food/health claims, e-cigarettes, children.
- [ ] Music in video adverts: licensing (IMRO/PPI) if audio is ever enabled — the player currently plays video muted.
- [ ] Irish VAT registration and rates confirmed with an accountant before charging; Stripe Tax configuration.
- [ ] Privacy notice and cookie notice (the web app uses one essential session cookie).
- [ ] Data Protection Commission guidance reviewed; DPIA if anything beyond the current minimal data is added.

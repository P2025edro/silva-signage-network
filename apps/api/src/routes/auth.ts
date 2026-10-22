import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createSession, clearSessionCookie, requireUser, SESSION_COOKIE } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { decryptSecret, encryptSecret, hashPassword, passwordProblems, sha256, verifyPassword } from '../lib/crypto.js';
import { badRequest, HttpError, unauthorized } from '../lib/errors.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../lib/totp.js';

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

export const authRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = app;
  let dummyHash: Promise<string> | null = null;

  r.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['auth'], body: z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }) },
    },
    async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      const now = deps.now();
      const [user] = await deps.sql<
        { id: string; password_hash: string; status: string; locked_until: Date | null; failed_logins: number; totp_enabled: boolean }[]
      >`SELECT id, password_hash, status, locked_until, failed_logins, totp_enabled FROM users WHERE email = ${email} AND deleted_at IS NULL`;

      if (!user) {
        // Same work as a real check, so response time doesn't reveal which emails exist.
        dummyHash ??= hashPassword('not-a-real-password', deps.config.SCRYPT_LOG_N);
        await verifyPassword(req.body.password, await dummyHash);
        throw unauthorized('Incorrect email or password');
      }
      if (user.locked_until && user.locked_until > now) {
        throw new HttpError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes.');
      }
      const ok = await verifyPassword(req.body.password, user.password_hash);
      if (!ok || user.status !== 'ACTIVE') {
        const failed = user.failed_logins + 1;
        await deps.sql`UPDATE users SET failed_logins = ${failed % MAX_FAILED},
          locked_until = ${failed >= MAX_FAILED ? new Date(now.getTime() + LOCK_MS) : null} WHERE id = ${user.id}`;
        await audit(deps.sql, { actorType: 'USER', actorId: user.id, action: 'auth.login_failed', ip: req.ip });
        throw unauthorized('Incorrect email or password');
      }
      await deps.sql`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ${now} WHERE id = ${user.id}`;
      await createSession(deps, reply, user.id, { ip: req.ip, userAgent: req.headers['user-agent'], mfaVerified: false });
      await audit(deps.sql, { actorType: 'USER', actorId: user.id, action: 'auth.login', ip: req.ip });
      return { mfaRequired: user.totp_enabled };
    },
  );

  r.post('/api/auth/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deps.sql`UPDATE sessions SET revoked_at = ${deps.now()} WHERE token_hash = ${sha256(token)}`;
    clearSessionCookie(reply);
    return { ok: true };
  });

  r.get('/api/auth/me', { schema: { tags: ['auth'] } }, async (req) => {
    const auth = requireUser(req);
    return {
      user: auth.user,
      mfaVerified: auth.mfaVerified,
      mfaRequired: auth.user.totpEnabled && !auth.mfaVerified,
      mfaEnrollmentRequired: auth.user.platformRole === 'SUPER_ADMIN' && !auth.user.totpEnabled && !deps.config.ALLOW_ADMIN_WITHOUT_MFA,
      memberships: auth.memberships,
    };
  });

  r.post(
    '/api/auth/mfa/verify',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['auth'], body: z.object({ code: z.string().length(6) }) } },
    async (req) => {
      const auth = requireUser(req);
      const [u] = await deps.sql<{ totp_secret_enc: string | null; totp_enabled: boolean }[]>`
        SELECT totp_secret_enc, totp_enabled FROM users WHERE id = ${auth.user.id}`;
      if (!u?.totp_enabled || !u.totp_secret_enc) throw badRequest('Two-factor authentication is not enabled');
      if (!verifyTotp(decryptSecret(deps.config.APP_SECRET, u.totp_secret_enc), req.body.code, deps.now().getTime())) {
        await audit(deps.sql, { actorType: 'USER', actorId: auth.user.id, action: 'auth.mfa_failed', ip: req.ip });
        throw unauthorized('Invalid code');
      }
      await deps.sql`UPDATE sessions SET mfa_verified = true WHERE id = ${auth.sessionId}`;
      return { ok: true };
    },
  );

  // Enrolment: setup returns a secret (stored but inactive) → enable confirms with a valid code.
  r.post('/api/auth/mfa/setup', { schema: { tags: ['auth'] } }, async (req) => {
    const auth = requireUser(req);
    if (auth.user.totpEnabled) throw badRequest('Two-factor authentication is already enabled');
    const secret = generateTotpSecret();
    await deps.sql`UPDATE users SET totp_secret_enc = ${encryptSecret(deps.config.APP_SECRET, secret)} WHERE id = ${auth.user.id}`;
    return { secret, otpauthUri: otpauthUri(secret, auth.user.email) };
  });

  r.post('/api/auth/mfa/enable', { schema: { tags: ['auth'], body: z.object({ code: z.string().length(6) }) } }, async (req) => {
    const auth = requireUser(req);
    const [u] = await deps.sql<{ totp_secret_enc: string | null }[]>`SELECT totp_secret_enc FROM users WHERE id = ${auth.user.id}`;
    if (!u?.totp_secret_enc) throw badRequest('Start setup first');
    if (!verifyTotp(decryptSecret(deps.config.APP_SECRET, u.totp_secret_enc), req.body.code, deps.now().getTime())) {
      throw badRequest('That code is not valid. Check the time on your phone and try again.');
    }
    await deps.sql.begin(async (tx) => {
      await tx`UPDATE users SET totp_enabled = true WHERE id = ${auth.user.id}`;
      await tx`UPDATE sessions SET mfa_verified = true WHERE id = ${auth.sessionId}`;
      await audit(tx, { actorType: 'USER', actorId: auth.user.id, action: 'auth.mfa_enabled', ip: req.ip });
    });
    return { ok: true };
  });

  r.post('/api/auth/password', { schema: { tags: ['auth'], body: z.object({ currentPassword: z.string(), newPassword: z.string() }) } }, async (req) => {
    const auth = requireUser(req);
    const problems = passwordProblems(req.body.newPassword);
    if (problems.length) throw badRequest(problems.join('. '));
    const [u] = await deps.sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${auth.user.id}`;
    if (!(await verifyPassword(req.body.currentPassword, u!.password_hash))) throw unauthorized('Current password is incorrect');
    const hash = await hashPassword(req.body.newPassword, deps.config.SCRYPT_LOG_N);
    await deps.sql.begin(async (tx) => {
      await tx`UPDATE users SET password_hash = ${hash}, updated_at = now() WHERE id = ${auth.user.id}`;
      // Sign out every other session.
      await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${auth.user.id} AND id <> ${auth.sessionId} AND revoked_at IS NULL`;
      await audit(tx, { actorType: 'USER', actorId: auth.user.id, action: 'auth.password_changed', ip: req.ip });
    });
    return { ok: true };
  });
};

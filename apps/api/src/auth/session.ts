import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomToken, sha256 } from '../lib/crypto.js';
import { forbidden, HttpError, notFound, unauthorized } from '../lib/errors.js';
import type { AuthContext, CompanyRole, Deps } from '../types.js';

export const SESSION_COOKIE = 'ssn_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // absolute lifetime
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // idle timeout

export async function createSession(
  deps: Deps,
  reply: FastifyReply,
  userId: string,
  meta: { ip: string; userAgent?: string; mfaVerified: boolean },
): Promise<string> {
  const token = randomToken(32);
  const now = deps.now();
  const [row] = await deps.sql<{ id: string }[]>`
    INSERT INTO sessions (user_id, token_hash, mfa_verified, ip, user_agent, expires_at, last_seen_at, created_at)
    VALUES (${userId}, ${sha256(token)}, ${meta.mfaVerified}, ${meta.ip}, ${meta.userAgent ?? null},
            ${new Date(now.getTime() + SESSION_TTL_MS)}, ${now}, ${now})
    RETURNING id`;
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: deps.config.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
  return row!.id;
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

async function loadAuth(deps: Deps, token: string): Promise<AuthContext | null> {
  const now = deps.now();
  const [row] = await deps.sql<
    {
      session_id: string;
      mfa_verified: boolean;
      last_seen_at: Date;
      user_id: string;
      email: string;
      full_name: string;
      platform_role: AuthContext['user']['platformRole'];
      totp_enabled: boolean;
    }[]
  >`
    SELECT s.id AS session_id, s.mfa_verified, s.last_seen_at, u.id AS user_id, u.email, u.full_name, u.platform_role, u.totp_enabled
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha256(token)} AND s.revoked_at IS NULL AND s.expires_at > ${now}
      AND u.status = 'ACTIVE' AND u.deleted_at IS NULL`;
  if (!row) return null;
  if (now.getTime() - row.last_seen_at.getTime() > SESSION_IDLE_MS) {
    await deps.sql`UPDATE sessions SET revoked_at = ${now} WHERE id = ${row.session_id}`;
    return null;
  }
  if (now.getTime() - row.last_seen_at.getTime() > 60_000) {
    await deps.sql`UPDATE sessions SET last_seen_at = ${now} WHERE id = ${row.session_id}`;
  }
  const memberships = await deps.sql<{ companyId: string; role: CompanyRole; companyName: string }[]>`
    SELECT m.company_id AS "companyId", m.role, c.name AS "companyName"
    FROM user_company_memberships m JOIN companies c ON c.id = m.company_id
    WHERE m.user_id = ${row.user_id} AND c.deleted_at IS NULL
    ORDER BY c.name`;
  return {
    user: { id: row.user_id, email: row.email, fullName: row.full_name, platformRole: row.platform_role, totpEnabled: row.totp_enabled },
    sessionId: row.session_id,
    mfaVerified: row.mfa_verified,
    memberships: [...memberships],
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Endpoints authenticated by something other than the session cookie. */
const CSRF_EXEMPT = [/^\/api\/device\//, /^\/api\/billing\/stripe\/webhook$/];

export function registerSessionHooks(app: FastifyInstance) {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    // CSRF: cookie-authenticated state changes must come from an allowed origin.
    if (token && !SAFE_METHODS.has(req.method) && !CSRF_EXEMPT.some((r) => r.test(req.url))) {
      const origin = req.headers.origin;
      const allowed = [...app.deps.config.webOrigins, app.deps.config.API_PUBLIC_URL];
      if (!origin || !allowed.includes(origin)) throw new HttpError(403, 'CSRF_REJECTED', 'Request origin not allowed');
    }
    req.auth = token ? await loadAuth(app.deps, token) : null;
  });
}

// ---- Authorisation helpers -------------------------------------------------

export function requireUser(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function isSilva(auth: AuthContext): boolean {
  return auth.user.platformRole === 'SUPER_ADMIN' || auth.user.platformRole === 'NETWORK_OPERATOR';
}

/** Throws unless MFA requirements for Silva staff are satisfied in this session. */
function assertSilvaMfa(deps: Deps, auth: AuthContext) {
  if (auth.user.totpEnabled && !auth.mfaVerified) throw new HttpError(403, 'MFA_REQUIRED', 'Verify your authenticator code to continue');
  if (auth.user.platformRole === 'SUPER_ADMIN' && !auth.user.totpEnabled && !deps.config.ALLOW_ADMIN_WITHOUT_MFA) {
    throw new HttpError(403, 'MFA_ENROLLMENT_REQUIRED', 'Super admins must enable two-factor authentication');
  }
}

export function requireSilva(req: FastifyRequest, deps: Deps, opts: { superAdminOnly?: boolean } = {}): AuthContext {
  const auth = requireUser(req);
  if (!isSilva(auth)) throw forbidden();
  if (opts.superAdminOnly && auth.user.platformRole !== 'SUPER_ADMIN') throw forbidden('Super admin access required');
  assertSilvaMfa(deps, auth);
  return auth;
}

export type CompanyAccessLevel = 'VIEW' | 'EDIT' | 'OWNER';
export type CompanyActor = { kind: 'SILVA'; superAdmin: boolean } | { kind: 'OWNER' } | { kind: 'STAFF' };

/**
 * Tenant gate for every company-scoped route. Non-members get 404 (not 403)
 * so company IDs can't be probed. Silva super admins have full access;
 * network operators can view.
 */
export function requireCompany(req: FastifyRequest, deps: Deps, companyId: string, level: CompanyAccessLevel): CompanyActor {
  const auth = requireUser(req);
  if (isSilva(auth)) {
    assertSilvaMfa(deps, auth);
    const superAdmin = auth.user.platformRole === 'SUPER_ADMIN';
    if (!superAdmin && level !== 'VIEW') throw forbidden('Network operators have read-only access to company data');
    return { kind: 'SILVA', superAdmin };
  }
  const m = auth.memberships.find((x) => x.companyId === companyId);
  if (!m) throw notFound('Company');
  if (level === 'OWNER' && m.role !== 'OWNER') throw forbidden('Only the account owner can do this');
  return m.role === 'OWNER' ? { kind: 'OWNER' } : { kind: 'STAFF' };
}

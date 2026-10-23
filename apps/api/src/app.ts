import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { WorkflowError } from '@silva/shared';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { registerSessionHooks } from './auth/session.js';
import { HttpError } from './lib/errors.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { billingRoutes } from './routes/billing.js';
import { campaignRoutes } from './routes/campaigns.js';
import { companyRoutes } from './routes/companies.js';
import { deviceRoutes } from './routes/device.js';
import { leadRoutes } from './routes/leads.js';
import { locationRoutes } from './routes/locations.js';
import { mediaRoutes } from './routes/media.js';
import { networkRoutes } from './routes/network.js';
import { screenRoutes } from './routes/screens.js';
import type { Deps } from './types.js';
import { maintenanceTick, schedulerTick } from './workers/index.js';

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.config.NODE_ENV === 'test' ? false : { level: deps.config.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: deps.config.NODE_ENV === 'production',
    bodyLimit: 1024 * 1024,
  });
  app.decorate('deps', deps);
  app.decorateRequest('device', null);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    // The API serves JSON and signed media only; the web app sets its own CSP.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // TV player loads media from this origin
  });
  // Browsers (cookie session) only from the configured web origins. The TV player authenticates
  // with a bearer token and may be served from any origin, so device and media routes allow any origin
  // without credentials.
  await app.register(cors, () => (req: { url?: string; headers: Record<string, string | string[] | undefined> }, cb: (e: Error | null, o: object) => void) => {
    const url = req.url ?? '';
    if (url.startsWith('/api/device/') || url.startsWith('/api/media-files/')) {
      return cb(null, { origin: '*', credentials: false, allowedHeaders: ['authorization', 'content-type', 'x-poll-secret'] });
    }
    const origin = req.headers.origin as string | undefined;
    cb(null, { origin: origin && deps.config.webOrigins.includes(origin) ? origin : false, credentials: true });
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { files: 1, fileSize: Math.max(deps.config.MEDIA_MAX_VIDEO_BYTES, deps.config.MEDIA_MAX_IMAGE_BYTES) } });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Silva Signage Network API', version: '0.1.0', description: 'Silva Solutions Ltd — indoor advertising network' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'ssn_session' }, device: { type: 'http', scheme: 'bearer' } } },
    },
    transform: jsonSchemaTransform,
  });
  if (deps.config.NODE_ENV !== 'production') await app.register(swaggerUi, { routePrefix: '/api/docs' });

  registerSessionHooks(app);

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Some fields are invalid', details: err.validation } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Some fields are invalid', details: err.issues } });
    }
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof WorkflowError) {
      const status = err.code === 'FORBIDDEN' ? 403 : err.code === 'REASON_REQUIRED' ? 400 : 409;
      return reply.status(status).send({ error: { code: err.code, message: err.message } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'REQUEST_ERROR', message: e.message } });
    }
    req.log.error({ err }, 'Unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. It has been logged.' } });
  });

  if (deps.config.LAZY_WORKERS) registerLazyWorkers(app, deps);

  app.get('/api/health', async () => {
    await deps.sql`SELECT 1`;
    return {
      ok: true,
      time: deps.now().toISOString(),
      demo: deps.config.DEMO_MODE,
      videoUploads: !deps.config.DISABLE_VIDEO_UPLOADS,
      maxImageBytes: deps.config.MEDIA_MAX_IMAGE_BYTES,
    };
  });

  await app.register(authRoutes);
  await app.register(companyRoutes);
  await app.register(locationRoutes);
  await app.register(screenRoutes);
  await app.register(deviceRoutes);
  await app.register(mediaRoutes);
  await app.register(campaignRoutes);
  await app.register(networkRoutes);
  await app.register(billingRoutes);
  await app.register(adminRoutes);
  await app.register(leadRoutes);
  return app;
}

/**
 * Serverless hosts have no long-running worker process. Instead, API traffic (TVs poll every
 * minute or so) drives the same ticks the worker would run: at most once a minute per instance for the
 * scheduler and once an hour for maintenance. The ticks take Postgres advisory locks, so concurrent
 * instances never run them twice at the same time.
 */
function registerLazyWorkers(app: FastifyInstance, deps: Deps) {
  let lastScheduler = 0;
  let lastMaintenance = 0;
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/media-files/')) return;
    const now = Date.now();
    try {
      if (now - lastScheduler >= 60_000) {
        lastScheduler = now;
        await schedulerTick(deps);
      }
      if (now - lastMaintenance >= 3_600_000) {
        lastMaintenance = now;
        await maintenanceTick(deps);
      }
    } catch (err) {
      req.log.error({ err }, 'Background tick failed');
    }
  });
}

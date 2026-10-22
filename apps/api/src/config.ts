import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  WEB_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  ALLOW_ADMIN_WITHOUT_MFA: bool,
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('eu-west-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  MEDIA_MAX_IMAGE_BYTES: z.coerce
    .number()
    .int()
    .default(10 * 1024 * 1024),
  MEDIA_MAX_VIDEO_BYTES: z.coerce
    .number()
    .int()
    .default(100 * 1024 * 1024),
  MEDIA_MAX_VIDEO_SECONDS: z.coerce.number().int().default(60),
  /** log2 of scrypt N. 17 follows OWASP guidance; tests lower it for speed. */
  SCRYPT_LOG_N: z.coerce.number().int().min(10).max(20).default(17),
  RUN_WORKERS_IN_PROCESS: bool,
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof EnvSchema> & { webOrigins: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production' && c.ALLOW_ADMIN_WITHOUT_MFA) {
    throw new Error('ALLOW_ADMIN_WITHOUT_MFA must not be enabled in production');
  }
  if (c.NODE_ENV === 'production' && c.APP_SECRET.startsWith('replace-with')) {
    throw new Error('APP_SECRET is still the template placeholder');
  }
  return {
    ...c,
    webOrigins: c.WEB_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

// Builds the whole product for Vercel using the Build Output API (.vercel/output):
//   /            web app (landing page, portal, admin)   → static
//   /player/     Smart TV web player                      → static
//   /api/*       Fastify API                              → one Node.js function
// Then applies pending migrations and the first admin (+ demo businesses when DEMO_MODE=true).
// Run by Vercel as the project's build command; can also be run locally to inspect the output.
import { execSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

const root = process.cwd();
const out = join(root, '.vercel/output');
const sh = (cmd, env = {}) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || 'localhost';
const region = process.env.FUNCTION_REGION || 'dub1';

rmSync(out, { recursive: true, force: true });

// 1. Static front ends (same origin as the API, so no API URL is baked in).
sh('pnpm --filter @silva/web build');
sh('pnpm --filter @silva/tv-player build', { PLAYER_API_URL: '', PLAYER_PORTAL_URL: process.env.PLAYER_PORTAL_URL || `${host}/login` });
cpSync('apps/web/dist', join(out, 'static'), { recursive: true });
cpSync('apps/tv-player/dist', join(out, 'static/player'), { recursive: true });

// 2. API function. Everything is bundled except sharp (native), which is installed for Linux.
const fn = join(out, 'functions/api.func');
mkdirSync(fn, { recursive: true });
await esbuild.build({
  entryPoints: ['apps/api/src/vercel.ts'],
  outfile: join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['sharp'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
const sharpVersion = JSON.parse(readFileSync('apps/api/node_modules/sharp/package.json', 'utf8')).version;
// Static ffmpeg/ffprobe for validating video uploads (and thumbnails) inside the function.
writeFileSync(
  join(fn, 'package.json'),
  JSON.stringify({
    type: 'module',
    dependencies: { sharp: sharpVersion, '@ffmpeg-installer/ffmpeg': '1.1.0', '@ffprobe-installer/ffprobe': '2.1.2' },
  }),
);
sh(`npm install --omit=dev --no-audit --no-fund --no-package-lock --os=linux --cpu=x64 --libc=glibc --prefix "${fn}"`);
// The function runs as a different user than the build: make the binaries executable for all.
for (const bin of ['node_modules/@ffmpeg-installer/linux-x64/ffmpeg', 'node_modules/@ffprobe-installer/linux-x64/ffprobe']) {
  if (existsSync(join(fn, bin))) chmodSync(join(fn, bin), 0o755);
}
writeFileSync(
  join(fn, '.vc-config.json'),
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, supportsResponseStreaming: true, maxDuration: 60, memory: 1024, regions: [region] }),
);

// 3. Routing.
writeFileSync(
  join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
        { src: '^/api(/.*)?$', dest: '/api' },
        { handle: 'filesystem' },
        { src: '^/player/?$', dest: '/player/index.html' },
        { src: '^/player/.*$', status: 404, dest: '/player/index.html' },
        { src: '^/.*$', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);

// 4. Database: migrations, first admin, demo businesses. Skipped when no database is connected yet.
if (process.env.DATABASE_URL) {
  sh('pnpm exec tsx apps/api/src/scripts/migrate.ts');
  sh(`pnpm exec tsx apps/api/src/scripts/seed.ts${process.env.DEMO_MODE === 'true' ? ' --demo' : ''}`);
} else {
  console.warn('DATABASE_URL is not set: skipped migrations and seeding.');
}
console.log('Vercel build output ready.');

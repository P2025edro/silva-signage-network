// Builds the TV player into dist/ as one small script plus static files.
// Target is old Chromium, which is what Tizen 4/5 and webOS 4/5 TV browsers are based on.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const serve = process.argv.includes('--serve');
const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: !serve,
  sourcemap: serve,
  target: ['chrome53', 'safari11'],
  format: 'iife',
  outfile: 'dist/player.js',
  define: {
    __API_URL__: JSON.stringify(process.env.PLAYER_API_URL ?? ''),
    __PORTAL_URL__: JSON.stringify(process.env.PLAYER_PORTAL_URL ?? 'app.silvasolutions.ie'),
    __PLAYER_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.1.0'),
  },
};

mkdirSync('dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: 'dist', port: Number(process.env.PLAYER_PORT ?? 5174), host: '0.0.0.0' });
  console.log(`TV player on http://localhost:${port}  (API: ${process.env.PLAYER_API_URL || 'same origin or ?api='})`);
} else {
  await esbuild.build(options);
  console.log('Built dist/player.js');
}

import { defineConfig } from '@playwright/test';

const E2E_DB = process.env.E2E_DATABASE_URL ?? 'postgres://silva:silva_dev@localhost:5432/silva_signage_e2e';
const API = 'http://localhost:4100';

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: { baseURL: 'http://localhost:5273', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: './.results',
  webServer: [
    {
      command: 'npx tsx src/server.ts',
      cwd: '../../apps/api',
      url: `${API}/api/health`,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: E2E_DB,
        API_PORT: '4100',
        API_PUBLIC_URL: API,
        WEB_ORIGINS: 'http://localhost:5273',
        APP_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
        ALLOW_ADMIN_WITHOUT_MFA: 'true',
        STORAGE_LOCAL_DIR: '../../tests/e2e/.storage',
        RUN_WORKERS_IN_PROCESS: 'true',
        SCRYPT_LOG_N: '12',
      },
    },
    {
      command: 'npx vite --port 5273 --strictPort',
      cwd: '../../apps/web',
      url: 'http://localhost:5273',
      reuseExistingServer: false,
      env: { API_PROXY_TARGET: API },
    },
    {
      command: 'node build.mjs --serve',
      cwd: '../../apps/tv-player',
      url: 'http://localhost:5274',
      reuseExistingServer: false,
      env: { PLAYER_API_URL: API, PLAYER_PORT: '5274', PLAYER_PORTAL_URL: 'localhost:5273' },
    },
  ],
});

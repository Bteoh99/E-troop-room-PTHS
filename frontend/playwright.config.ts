import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * E2E config. Chromium is preinstalled (PLAYWRIGHT_BROWSERS_PATH) — never run `playwright install`.
 *
 * By default this starts:
 *   1. the real backend on :3001 with a fresh temp SQLite DB, seeded (`npm run seed && npm start` in ../backend)
 *   2. the Vite dev server on :5173 (proxies /api to :3001)
 * Set E2E_NO_SERVER=1 to use servers you already started yourself.
 * Override ports with E2E_BACKEND_PORT / E2E_WEB_PORT (and the DB file with E2E_DB_PATH).
 */
const dbPath = process.env.E2E_DB_PATH ?? path.join(os.tmpdir(), `etroop-e2e-${process.pid}.db`);
const startServers = !process.env.E2E_NO_SERVER;
// Ports are overridable so several agents/CI jobs can run e2e side by side (defaults unchanged).
const backendPort = process.env.E2E_BACKEND_PORT ?? '3001';
const webPort = process.env.E2E_WEB_PORT ?? '5173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${webPort}`,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    {
      name: 'mobile-360',
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: startServers
    ? [
        {
          command: 'npm run seed && npm start',
          cwd: path.resolve(here, '../backend'),
          env: { DB_PATH: dbPath, PORT: backendPort },
          url: `http://localhost:${backendPort}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          command: `npm run dev -- --strictPort --port ${webPort}`,
          cwd: here,
          env: { BACKEND_URL: `http://localhost:${backendPort}` },
          url: `http://localhost:${webPort}`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      ]
    : undefined,
});

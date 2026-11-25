import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * E2E config. Chromium is preinstalled (PLAYWRIGHT_BROWSERS_PATH) — never run `playwright install`.
 *
 * By default this starts its OWN servers on dedicated ports, so e2e never touches a developer's
 * real backend or store-room data:
 *   1. the real backend on :3901 with a brand-new temp SQLite DB, seeded (`npm run seed && npm start` in ../backend)
 *   2. the Vite dev server on :5901 (proxies /api to the e2e backend)
 * Neither server is ever reused: if a port is busy the run fails instead of writing into someone else's data.
 *
 * Env overrides: E2E_BACKEND_PORT, E2E_WEB_PORT, E2E_DB_PATH (must be a scratch file — it is written to),
 * E2E_NO_SERVER=1 + E2E_BASE_URL to run against servers you started yourself.
 */
const backendPort = process.env.E2E_BACKEND_PORT ?? '3901';
const webPort = process.env.E2E_WEB_PORT ?? '5901';
// Unique per run (the main process computes it once; only the main process starts the servers).
const dbPath = process.env.E2E_DB_PATH ?? path.join(os.tmpdir(), `etroop-e2e-${process.pid}-${Date.now()}.db`);
const startServers = !process.env.E2E_NO_SERVER;

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
          reuseExistingServer: false,
          timeout: 60_000,
        },
        {
          command: `npm run dev -- --strictPort --port ${webPort}`,
          cwd: here,
          env: { BACKEND_URL: `http://localhost:${backendPort}` },
          url: `http://localhost:${webPort}`,
          reuseExistingServer: false,
          timeout: 60_000,
        },
      ]
    : undefined,
});

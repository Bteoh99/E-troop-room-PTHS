import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
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
 *
 * Phase 1.5 leader PIN: the e2e backend gets its own temp CONFIG_PATH and the PIN E2E_PIN (default 246810)
 * via `npm run set-pin -- --pin` (skipped if the backend has no such script yet). e2e/global-setup.ts
 * logs in once and stores the token, so tests run in leader mode (browser localStorage only; API helpers
 * send it explicitly via e2e/leader.ts).
 * Tests that need the locked state use an empty storageState.
 */
const backendPort = process.env.E2E_BACKEND_PORT ?? '3901';
const webPort = process.env.E2E_WEB_PORT ?? '5901';
// Unique per run (the main process computes it once; only the main process starts the servers).
const dbPath = process.env.E2E_DB_PATH ?? path.join(os.tmpdir(), `etroop-e2e-${process.pid}-${Date.now()}.db`);
const startServers = !process.env.E2E_NO_SERVER;
// Shared between the runner and its workers (workers inherit the env and re-read this config).
process.env.E2E_RUN_ID ??= `${process.pid}-${Date.now()}`;
const runDir = path.join(os.tmpdir(), `etroop-e2e-${process.env.E2E_RUN_ID}`);
const configPath = path.join(runDir, 'config.json');
export const E2E_PIN = process.env.E2E_PIN ?? '246810';
process.env.E2E_PIN = E2E_PIN;
process.env.E2E_STATE_DIR = runDir;
// With E2E_NO_SERVER the base URL is usually the backend itself (production mode serves the app).
process.env.E2E_BACKEND_URL ??=
  !startServers && process.env.E2E_BASE_URL && !process.env.E2E_BACKEND_PORT
    ? process.env.E2E_BASE_URL
    : `http://localhost:${backendPort}`;
// Written by global-setup (after the servers are up); only workers read it, which is all that matters.
// The token reaches the app ONLY through this storage state (localStorage). API helpers in specs add the
// header explicitly (e2e/leader.ts) — never use.extraHTTPHeaders, which Playwright would also add to every
// browser request and so hide the app's own token handling (locked state, 401 retry).
const storageStatePath = path.join(runDir, 'leader-state.json');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${webPort}`,
    storageState: existsSync(storageStatePath) ? storageStatePath : undefined,
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
          command: `npm run seed && npm run --if-present set-pin -- --pin ${E2E_PIN} && npm start`,
          cwd: path.resolve(here, '../backend'),
          env: { DB_PATH: dbPath, PORT: backendPort, CONFIG_PATH: configPath },
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

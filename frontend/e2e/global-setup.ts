import type { FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Logs in to the e2e backend with the e2e PIN once, and saves the leader token so every test runs in
 * leader mode: as browser localStorage (storageState) and as an Authorization header for API calls.
 * If the backend has no /api/auth yet (pre-Phase-1.5), nothing is saved and tests run as before.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const dir = process.env.E2E_STATE_DIR!;
  const backend = process.env.E2E_BACKEND_URL!;
  const baseURL = String(config.projects[0]?.use.baseURL ?? '');
  mkdirSync(dir, { recursive: true });
  let token = '';
  let expiresAt: string | undefined;
  try {
    const res = await fetch(`${backend}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: process.env.E2E_PIN }),
    });
    if (res.ok) {
      const body = (await res.json()) as { token: string; expiresAt?: string };
      token = body.token;
      expiresAt = body.expiresAt;
    } else {
      console.log(`[e2e] leader login not available (HTTP ${res.status}); running without a leader token`);
    }
  } catch (err) {
    console.log(`[e2e] leader login failed: ${String(err)}`);
  }
  const origin = new URL(baseURL).origin;
  writeFileSync(
    path.join(dir, 'leader-state.json'),
    JSON.stringify({
      cookies: [],
      origins: token
        ? [{ origin, localStorage: [{ name: 'etroop.leaderToken', value: JSON.stringify({ token, expiresAt }) }] }]
        : [],
    }),
  );
  writeFileSync(path.join(dir, 'leader-token.txt'), token);
}

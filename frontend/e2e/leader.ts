import fs from 'node:fs';
import path from 'node:path';

/**
 * The leader token that e2e/global-setup.ts got from the e2e backend, as an Authorization header
 * for API helper calls (`request.post(url, { data, headers: leaderHeaders() })`).
 * Empty when the backend has no leader PIN support.
 */
export function leaderHeaders(): Record<string, string> {
  const dir = process.env.E2E_STATE_DIR;
  const file = dir ? path.join(dir, 'leader-token.txt') : '';
  const token = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

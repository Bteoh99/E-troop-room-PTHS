import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Every test file gets its own in-memory database via the default app export.
    // CONFIG_PATH points at a file that does not exist: the default app has no PIN (setup-needed);
    // tests that write use makeApp() from tests/helpers.js, which sets up a temp PIN.
    env: { DB_PATH: ':memory:', NODE_ENV: 'test', CONFIG_PATH: path.join(os.tmpdir(), 'etroop-vitest-no-config', 'config.json') },
    pool: 'forks',
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Every test file gets its own in-memory database via the default app export.
    env: { DB_PATH: ':memory:', NODE_ENV: 'test' },
    pool: 'forks',
  },
});

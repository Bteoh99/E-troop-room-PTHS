import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  // Leader-mode token (Phase 1.5) must not leak between tests.
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

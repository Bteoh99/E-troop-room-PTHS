/**
 * Leader-mode token storage. localStorage can throw or silently refuse writes (private mode,
 * full quota, locked-down WebViews), so every access is wrapped; when the token can't be stored
 * it lives in memory for this tab/session instead.
 */
export const TOKEN_STORAGE_KEY = 'etroop.leaderToken';

export interface StoredToken {
  token: string;
  /** ISO-8601 expiry from the server; missing = unknown (treated as valid until the server says 401). */
  expiresAt?: string;
}

let memory: StoredToken | null = null;
/** True when the last write could not be persisted: the in-memory copy is then the truth. */
let memoryOnly = false;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

function parse(raw: string): StoredToken | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { token: raw }; // a bare token string
  }
  if (parsed && typeof parsed === 'object' && typeof (parsed as StoredToken).token === 'string') {
    return parsed as StoredToken;
  }
  return typeof parsed === 'string' ? { token: parsed } : null;
}

function readStorage(): StoredToken | null {
  if (memoryOnly) return memory;
  try {
    const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    return raw ? parse(raw) : null;
  } catch {
    return memory;
  }
}

function isExpired(t: StoredToken): boolean {
  if (!t.expiresAt) return false;
  const when = Date.parse(t.expiresAt);
  return Number.isFinite(when) && when <= Date.now();
}

/** The current, unexpired token (or null). */
export function getToken(): string | null {
  const t = readStorage();
  if (!t || isExpired(t)) return null;
  return t.token;
}

/** Milliseconds until the stored token expires (null = no known expiry / no token). */
export function msUntilExpiry(): number | null {
  const t = readStorage();
  if (!t?.expiresAt) return null;
  const when = Date.parse(t.expiresAt);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

export function setToken(token: string, expiresAt?: string): void {
  memory = { token, expiresAt };
  memoryOnly = false;
  try {
    const value = JSON.stringify(memory);
    window.localStorage.setItem(TOKEN_STORAGE_KEY, value);
    // Some browsers accept the write but don't keep it — check.
    if (window.localStorage.getItem(TOKEN_STORAGE_KEY) !== value) memoryOnly = true;
  } catch {
    memoryOnly = true; // storage unavailable or full: keep it for this session only
  }
  notify();
}

export function clearToken(): void {
  memory = null;
  memoryOnly = false;
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  notify();
}

export function subscribeToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Another tab locked/unlocked: follow it.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== TOKEN_STORAGE_KEY && e.key !== null) return;
    if (!memoryOnly) memory = null;
    notify();
  });
}

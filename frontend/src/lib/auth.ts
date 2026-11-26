/**
 * Leader-mode token storage. localStorage can throw (private mode, blocked storage), so every
 * access is wrapped; without storage the token simply lives in memory for this tab.
 */
export const TOKEN_STORAGE_KEY = 'etroop.leaderToken';

export interface StoredToken {
  token: string;
  /** ISO-8601 expiry from the server; missing = unknown (treated as valid until the server says 401). */
  expiresAt?: string;
}

let memory: StoredToken | null = null;
const listeners = new Set<() => void>();

/** The stored token; falls back to the in-memory copy only when localStorage itself fails. */
function readStorage(): StoredToken | null {
  try {
    const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { token: raw }; // a bare token string
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as StoredToken).token === 'string') {
      return parsed as StoredToken;
    }
    // Tolerate a bare token string.
    return typeof parsed === 'string' ? { token: parsed } : null;
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

export function setToken(token: string, expiresAt?: string): void {
  memory = { token, expiresAt };
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(memory));
  } catch {
    /* storage unavailable: keep it in memory */
  }
  listeners.forEach((l) => l());
}

export function clearToken(): void {
  memory = null;
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function subscribeToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api } from '../api/client';
import { clearToken, getToken, setToken, subscribeToken } from '../lib/auth';
import { PinDialog, type PinDialogMode } from './PinDialog';

/** Thrown by runAsLeader when the user closes the PIN dialog instead of unlocking. */
export class LeaderCancelledError extends Error {
  constructor() {
    super('Leader PIN needed');
    this.name = 'LeaderCancelledError';
  }
}

export function isLeaderCancelled(err: unknown): err is LeaderCancelledError {
  return err instanceof LeaderCancelledError;
}

/** The 403 the server sends when no PIN has been set on the laptop yet. */
function isSetupNeeded(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

interface LeaderApi {
  /** True while a valid leader token is stored. */
  leader: boolean;
  /** Resolves true once in leader mode (asking for the PIN if needed), false if the user cancels. */
  requireLeader: (reason?: string) => Promise<boolean>;
  /**
   * Runs a write in leader mode: asks for the PIN first when locked, and if the server answers 401
   * (expired/invalid token) clears it, asks again and retries once. Throws LeaderCancelledError on cancel.
   */
  runAsLeader: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Opens the PIN dialog (no follow-up action). */
  unlock: () => void;
  lock: () => void;
}

const LeaderContext = createContext<LeaderApi | null>(null);

interface DialogState {
  mode: PinDialogMode;
  reason?: string;
}

export function LeaderProvider({ children }: { children: ReactNode }) {
  const [leader, setLeader] = useState(() => getToken() !== null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const waiters = useRef<((ok: boolean) => void)[]>([]);

  useEffect(() => subscribeToken(() => setLeader(getToken() !== null)), []);

  // Ask the server whether the stored token is still good (PIN changed, secret rotated, expired).
  useEffect(() => {
    if (!getToken()) return;
    let active = true;
    Promise.resolve()
      .then(() => api.authStatus())
      .then((status) => {
        if (active && status && typeof status === 'object' && status.leader === false) clearToken();
      })
      .catch(() => {
        /* offline or older server: keep the token, the next write will tell */
      });
    return () => {
      active = false;
    };
  }, []);

  const settle = useCallback((ok: boolean) => {
    const pending = waiters.current;
    waiters.current = [];
    setDialog(null);
    pending.forEach((resolve) => resolve(ok));
  }, []);

  const open = useCallback((mode: PinDialogMode, reason?: string) => {
    return new Promise<boolean>((resolve) => {
      waiters.current.push(resolve);
      setDialog({ mode, reason });
    });
  }, []);

  const requireLeader = useCallback(
    (reason?: string) => (getToken() ? Promise.resolve(true) : open('pin', reason)),
    [open],
  );

  const runAsLeader = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      if (!(await requireLeader())) throw new LeaderCancelledError();
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          if (!(await open('pin', 'Your leader session has ended. Enter the PIN again to carry on.'))) {
            throw new LeaderCancelledError();
          }
          return fn();
        }
        if (isSetupNeeded(err)) {
          await open('setup');
          throw new LeaderCancelledError();
        }
        throw err;
      }
    },
    [open, requireLeader],
  );

  const value = useMemo<LeaderApi>(
    () => ({
      leader,
      requireLeader,
      runAsLeader,
      unlock: () => void open('pin'),
      lock: () => clearToken(),
    }),
    [leader, open, requireLeader, runAsLeader],
  );

  return (
    <LeaderContext.Provider value={value}>
      {children}
      {dialog && (
        <PinDialog
          mode={dialog.mode}
          reason={dialog.reason}
          onUnlocked={(token, expiresAt) => {
            setToken(token, expiresAt);
            settle(true);
          }}
          onSetupNeeded={() => setDialog({ mode: 'setup' })}
          onCancel={() => settle(false)}
        />
      )}
    </LeaderContext.Provider>
  );
}

export function useLeader(): LeaderApi {
  const ctx = useContext(LeaderContext);
  if (!ctx) throw new Error('useLeader must be used inside <LeaderProvider>');
  return ctx;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api } from '../api/client';
import { clearToken, getToken, msUntilExpiry, setToken, subscribeToken } from '../lib/auth';
import { announce } from '../lib/routeFocus';
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

/** 403: no PIN set on the laptop yet. 503: the laptop's leader settings file is damaged. */
function setupProblem(err: unknown): PinDialogMode | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status === 403) return 'setup';
  if (err.status === 503) return 'damaged';
  return null;
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
  /** Shown to leaders after unlocking with an old short PIN. */
  pinNotice: string | null;
  dismissPinNotice: () => void;
}

export const SHORT_PIN_NOTICE = 'Please ask the quartermaster to set a 6-digit PIN (the current one is shorter).';

const LeaderContext = createContext<LeaderApi | null>(null);

interface DialogState {
  mode: PinDialogMode;
  reason?: string;
}

export function LeaderProvider({ children }: { children: ReactNode }) {
  const [leader, setLeader] = useState(() => getToken() !== null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  const waiters = useRef<((ok: boolean) => void)[]>([]);

  useEffect(() => subscribeToken(() => setLeader(getToken() !== null)), []);

  // Turn the button back to 🔒 when the token's 30 days run out while the app is open.
  useEffect(() => {
    if (!leader) return;
    const ms = msUntilExpiry();
    if (ms === null) return;
    const t = window.setTimeout(() => setLeader(getToken() !== null), Math.min(ms + 1000, 2 ** 31 - 1));
    return () => window.clearTimeout(t);
  }, [leader]);

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
        const problem = setupProblem(err);
        if (problem) {
          await open(problem);
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
      lock: () => {
        clearToken();
        setPinNotice(null);
        announce('Leader mode off.');
      },
      pinNotice,
      dismissPinNotice: () => setPinNotice(null),
    }),
    [leader, open, requireLeader, runAsLeader, pinNotice],
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
            announce('Leader mode on.');
            settle(true);
            // Old 4–5 digit PIN? Nudge leaders to have it changed (doesn't block anything).
            Promise.resolve()
              .then(() => api.authStatus())
              .then((status) => {
                if (status && typeof status === 'object' && status.pinTooShort) setPinNotice(SHORT_PIN_NOTICE);
              })
              .catch(() => {});
          }}
          onSetupNeeded={(mode) => setDialog({ mode })}
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

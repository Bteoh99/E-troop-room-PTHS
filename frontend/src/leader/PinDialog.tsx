import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api/client';
import { waitText } from '../lib/wait';

/** pin = ask for the PIN; setup = no PIN set on the laptop (403); damaged = settings file broken (503). */
export type PinDialogMode = 'pin' | 'setup' | 'damaged';

interface Props {
  mode: PinDialogMode;
  reason?: string;
  onUnlocked: (token: string, expiresAt?: string) => void;
  onSetupNeeded: (mode: 'setup' | 'damaged') => void;
  onCancel: () => void;
}

export const SETUP_NEEDED_TEXT =
  'The leader PIN has not been set up yet. On the store-room laptop, run "set-pin" (see the setup guide), then try again.';
export const DAMAGED_TEXT =
  'The leader settings file on the store-room laptop is damaged. On the laptop, run "set-pin" to repair it (see the setup guide), then try again.';

/** Friendly text for a 429 from /api/auth/login, using the server's Retry-After. */
export function tooManyText(err: ApiError): string {
  const secs = err.retryAfterSeconds;
  if (secs !== undefined && secs <= 10) return 'Please wait a moment, then try again.';
  return `Too many wrong tries — wait ${secs === undefined ? '5 minutes' : waitText(secs)}, then try again.`;
}

/**
 * Modal asking for the leader PIN. New PINs are 6–8 digits; an older 4–5 digit PIN still works
 * until the quartermaster changes it, so 4–5 digits are sent to the server too (it decides).
 */
export function PinDialog({ mode, reason, onUnlocked, onSetupNeeded, onCancel }: Props) {
  const titleId = useId();
  const inputId = useId();
  const msgId = useId();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const previously = document.activeElement as HTMLElement | null;
    (mode === 'pin' ? inputRef.current : closeRef.current)?.focus();
    return () => previously?.focus?.();
  }, [mode]);

  // After a failed try, put the cursor back in the PIN box *after* React has re-enabled things
  // (focusing in the same tick as setBusy(false) would hit a still-disabled control).
  useEffect(() => {
    if (attempt > 0 && !busy) inputRef.current?.focus();
  }, [attempt, busy]);

  // Escape and the Tab trap work wherever focus is, even if it slipped out of the dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busyRef.current) {
        e.stopPropagation();
        cancelRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const f = dialogRef.current.querySelectorAll<HTMLElement>('input, button:not([disabled])');
      if (f.length === 0) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      const inside = dialogRef.current.contains(document.activeElement);
      if (!inside) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!/^\d{4,8}$/.test(pin)) {
      setError('The PIN is 6 to 8 digits.');
      setAttempt((n) => n + 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(pin);
      onUnlocked(res.token, res.expiresAt);
    } catch (err) {
      setBusy(false);
      setPin('');
      if (err instanceof ApiError && err.status === 401) setError("That PIN isn't right. Please try again.");
      else if (err instanceof ApiError && err.status === 429) setError(tooManyText(err));
      else if (err instanceof ApiError && err.status === 403) return onSetupNeeded('setup');
      else if (err instanceof ApiError && err.status === 503) return onSetupNeeded('damaged');
      else setError(err instanceof Error ? err.message : 'Could not check the PIN.');
      setAttempt((n) => n + 1);
    }
  }

  const problem = mode === 'setup' ? SETUP_NEEDED_TEXT : mode === 'damaged' ? DAMAGED_TEXT : null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div
        ref={dialogRef}
        className="modal pin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={msgId}
        data-testid="pin-dialog"
      >
        <h2 id={titleId} className="modal__title">
          <span aria-hidden="true">🔒 </span>
          {mode === 'setup'
            ? 'Leader PIN not set up'
            : mode === 'damaged'
              ? 'Leader PIN settings damaged'
              : 'Leader PIN'}
        </h2>
        {problem ? (
          <>
            <p id={msgId}>{problem}</p>
            <div className="modal__actions">
              <button ref={closeRef} type="button" className="btn btn--primary" onClick={onCancel}>
                OK
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <p id={msgId} className="modal__body">
              {reason ?? 'Adding, editing, deleting and importing need the leader PIN.'}
            </p>
            <div className="field">
              <label htmlFor={inputId}>PIN</label>
              <p className="field__hint" id={`${inputId}-hint`}>
                6 to 8 digits
              </p>
              {/* readOnly (not disabled) while checking: focus and the phone keyboard stay put. */}
              <input
                ref={inputRef}
                id={inputId}
                className="pin-input"
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                maxLength={8}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${inputId}-err ${inputId}-hint` : `${inputId}-hint`}
                readOnly={busy}
                aria-busy={busy || undefined}
              />
              {error && (
                <p id={`${inputId}-err`} className="field__error" role="alert">
                  <span aria-hidden="true">⚠ </span>
                  {error}
                </p>
              )}
            </div>
            <div className="modal__actions">
              <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn btn--primary" disabled={busy}>
                {busy ? 'Checking…' : 'Unlock'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

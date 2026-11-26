import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ApiError, api } from '../api/client';

export type PinDialogMode = 'pin' | 'setup';

interface Props {
  mode: PinDialogMode;
  reason?: string;
  onUnlocked: (token: string, expiresAt?: string) => void;
  onSetupNeeded: () => void;
  onCancel: () => void;
}

export const SETUP_NEEDED_TEXT =
  'The leader PIN has not been set up yet. On the store-room laptop, run "set-pin" (see the setup guide), then try again.';

/** Modal asking for the leader PIN (4–8 digits). */
export function PinDialog({ mode, reason, onUnlocked, onSetupNeeded, onCancel }: Props) {
  const titleId = useId();
  const inputId = useId();
  const msgId = useId();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previously = document.activeElement as HTMLElement | null;
    (mode === 'pin' ? inputRef.current : closeRef.current)?.focus();
    return () => previously?.focus?.();
  }, [mode]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{4,8}$/.test(pin)) {
      setError('The PIN is 4 to 8 digits.');
      inputRef.current?.focus();
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
      else if (err instanceof ApiError && err.status === 429)
        setError('Too many wrong tries — wait 5 minutes, then try again.');
      else if (err instanceof ApiError && err.status === 403) onSetupNeeded();
      else setError(err instanceof Error ? err.message : 'Could not check the PIN.');
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key === 'Tab' && dialogRef.current) {
      const f = dialogRef.current.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])');
      if (f.length === 0) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div
        ref={dialogRef}
        className="modal pin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={msgId}
        onKeyDown={onKeyDown}
        data-testid="pin-dialog"
      >
        <h2 id={titleId} className="modal__title">
          <span aria-hidden="true">🔒 </span>
          {mode === 'setup' ? 'Leader PIN not set up' : 'Leader PIN'}
        </h2>
        {mode === 'setup' ? (
          <>
            <p id={msgId}>{SETUP_NEEDED_TEXT}</p>
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
                aria-describedby={error ? `${inputId}-err` : undefined}
                disabled={busy}
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

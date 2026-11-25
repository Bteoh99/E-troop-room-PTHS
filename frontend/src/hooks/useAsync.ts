import { useCallback, useEffect, useRef, useState } from 'react';

export type AsyncState<T> =
  | { status: 'loading'; data?: T; error?: undefined }
  | { status: 'success'; data: T; error?: undefined }
  | { status: 'error'; data?: T; error: Error };

/**
 * Runs `fn` whenever `deps` change. Aborts the previous request and ignores stale
 * responses, so the latest call always wins. Returns state plus a `reload` function.
 */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState((prev) => ({ status: 'loading', data: prev.data }));
    fnRef
      .current(controller.signal)
      .then((data) => {
        if (active) setState({ status: 'success', data });
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState((prev) => ({
          status: 'error',
          data: prev.data,
          error: err instanceof Error ? err : new Error(String(err)),
        }));
      });
    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

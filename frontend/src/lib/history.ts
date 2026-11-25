import type { Location } from 'react-router-dom';

/**
 * Router state marking "this entry is the first one in the app's history", so a Back link
 * must not call navigate(-1) (that would leave the app). Carried over replace navigations.
 */
export interface HistoryState {
  root?: boolean;
}

export function isRootEntry(location: Location): boolean {
  return location.key === 'default' || Boolean((location.state as HistoryState | null)?.root);
}

/** State to pass with `navigate(to, { replace: true, state })` so root-ness survives the replace. */
export function replaceState(location: Location): HistoryState | null {
  return isRootEntry(location) ? { root: true } : null;
}

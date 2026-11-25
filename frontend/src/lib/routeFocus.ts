/**
 * Focus management on route change (WCAG 2.4.3). The Layout marks a pathname change;
 * the next page heading that mounts takes focus (or, if the page already focused
 * something itself — e.g. the autofocused search box — it is announced instead).
 */
let pending = false;
let announcer: ((message: string) => void) | null = null;

export function markRouteChange(): void {
  pending = true;
}

export function isRouteFocusPending(): boolean {
  return pending;
}

export function consumeRouteFocus(): boolean {
  const was = pending;
  pending = false;
  return was;
}

export function setAnnouncer(fn: ((message: string) => void) | null): void {
  announcer = fn;
}

export function announce(message: string): void {
  announcer?.(message);
}

/** True when focus is "nowhere useful": body, the main landmark, or outside main (e.g. the clicked tab). */
export function focusIsFree(main: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  if (!main) return true;
  return active === main || !main.contains(active);
}

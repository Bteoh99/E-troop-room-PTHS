/**
 * One-off confirmation messages ("Changes saved.") shown by the Layout on the *next* page.
 * Pages call showFlash() right before navigating; the Layout picks the message up when the
 * location changes. Used instead of router state so it also works with navigate(-1).
 */
let pending: string | null = null;

export function showFlash(message: string): void {
  pending = message;
}

/** Returns the queued message (if any) and clears it. */
export function takeFlash(): string | null {
  const message = pending;
  pending = null;
  return message;
}

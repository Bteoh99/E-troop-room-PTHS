/** "30 seconds", "1 minute", "5 minutes" — for "wait N …" messages built from Retry-After. */
export function waitText(seconds: number): string {
  if (seconds < 60) {
    const s = Math.max(1, Math.round(seconds));
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  const m = Math.ceil(seconds / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

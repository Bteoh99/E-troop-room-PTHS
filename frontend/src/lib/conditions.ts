import type { Condition } from '../api/types';

export const CONDITION_LABELS: Record<Condition, string> = {
  good: 'Good',
  needs_repair: 'Needs repair',
  damaged: 'Damaged',
  written_off: 'Written off',
};

/** Small text symbol so condition is never conveyed by colour alone. */
export const CONDITION_SYMBOLS: Record<Condition, string> = {
  good: '✓',
  needs_repair: '!',
  damaged: '✕',
  written_off: '–',
};

export function conditionLabel(value: string | null | undefined): string {
  if (value && value in CONDITION_LABELS) return CONDITION_LABELS[value as Condition];
  return value ?? 'Unknown';
}

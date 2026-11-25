import type { Condition } from '../api/types';
import { CONDITION_SYMBOLS, conditionLabel } from '../lib/conditions';

export function ConditionChip({ condition }: { condition: Condition }) {
  return (
    <span className={`chip chip--${condition}`}>
      <span aria-hidden="true" className="chip__symbol">
        {CONDITION_SYMBOLS[condition] ?? '?'}
      </span>
      <span className="visually-hidden">Condition: </span>
      {conditionLabel(condition)}
    </span>
  );
}

import { Link } from 'react-router-dom';
import type { Item } from '../api/types';
import { ConditionChip } from './ConditionChip';
import { LocationBadge } from './LocationBadge';

export function ItemCard({ item }: { item: Item }) {
  return (
    <article className="card item-card" data-testid="item-card">
      <div className="item-card__main">
        <div className="item-card__meta">
          <span className="code">{item.code}</span>
          <ConditionChip condition={item.condition} />
        </div>
        <h3 className="item-card__name">
          <Link to={`/items/${item.id}`} className="stretched-link">
            {item.name}
          </Link>
        </h3>
        <p className="item-card__sub">
          <span>
            Qty <strong>{item.quantity}</strong> {item.unit}
          </span>
          {item.category && <span className="item-card__cat">{item.category}</span>}
        </p>
      </div>
      <div className="item-card__loc">
        <LocationBadge
          locationCode={item.locationCode}
          rack={item.rack}
          shelf={item.shelf}
          bin={item.bin}
          size="lg"
          showDescription
        />
      </div>
    </article>
  );
}

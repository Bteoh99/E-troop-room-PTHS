import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Item } from '../api/types';
import { ConditionChip } from './ConditionChip';
import { LocationBadge } from './LocationBadge';

/** "Coleman · Sundome 4P" (brand and model, whichever are set), or null. */
export function makeLine(item: Pick<Item, 'brand' | 'model'>): string | null {
  const parts = [item.brand, item.model].map((v) => v?.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function ItemCard({ item, extra }: { item: Item; extra?: ReactNode }) {
  const make = makeLine(item);
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
        {(make || item.barcode) && (
          <p className="item-card__make">
            {make && <span>{make}</span>}
            {item.barcode && (
              <span className="item-card__barcode">
                <span className="visually-hidden">Barcode </span>
                <span aria-hidden="true">▌▍▌ </span>
                {item.barcode}
              </span>
            )}
          </p>
        )}
        <p className="item-card__sub">
          <span>
            Qty <strong>{item.quantity}</strong> {item.unit}
          </span>
          {item.category && <span className="item-card__cat">{item.category}</span>}
        </p>
        {extra}
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

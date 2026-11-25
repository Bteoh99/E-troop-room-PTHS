import { Link } from 'react-router-dom';
import type { RackSummary } from '../api/types';

interface Props {
  racks: RackSummary[];
  highlightRack?: string | null;
  /** When true each tile links to its rack view. */
  linkTiles?: boolean;
  compact?: boolean;
}

function shelfSpan(shelves: string[]): string {
  if (shelves.length === 0) return 'No shelves yet';
  const sorted = [...shelves].sort();
  return sorted.length === 1 ? `Shelf ${sorted[0]}` : `Shelves ${sorted[0]}–${sorted[sorted.length - 1]}`;
}

/** Bird's-eye view of the store room: one tile per rack. */
export function StoreMap({ racks, highlightRack, linkTiles = true, compact = false }: Props) {
  return (
    <div className={`room${compact ? ' room--compact' : ''}`} data-testid="store-map">
      <ul className="room__grid" aria-label="Racks in the store room">
        {racks.map((r) => {
          const hit = r.rack === highlightRack;
          const content = (
            <>
              <span className="tile__name">{r.rack}</span>
              <span className="tile__count">
                {r.itemCount} item{r.itemCount === 1 ? '' : 's'}
              </span>
              {!compact && <span className="tile__shelves">{shelfSpan(r.shelves)}</span>}
              {hit && (
                <span className="tile__here">
                  <span aria-hidden="true">📍 </span>Here
                </span>
              )}
            </>
          );
          const cls = `tile${hit ? ' is-hit' : ''}`;
          return (
            <li key={r.rack} data-rack={r.rack} data-highlighted={hit || undefined}>
              {linkTiles ? (
                <Link
                  to={`/racks/${encodeURIComponent(r.rack)}`}
                  className={cls}
                  aria-label={`Rack ${r.rack}, ${r.itemCount} item${r.itemCount === 1 ? '' : 's'}${hit ? ', this item is here' : ''}`}
                >
                  {content}
                </Link>
              ) : (
                <div className={cls}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="room__door" aria-hidden="true">
        <span>Door</span>
      </div>
    </div>
  );
}

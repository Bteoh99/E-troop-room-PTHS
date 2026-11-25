import type { Item } from '../api/types';
import { shelfRange } from '../lib/location';

interface Props {
  rack: string;
  /** Items in this rack (used to size the diagram and mark occupied bins). */
  items: Pick<Item, 'id' | 'shelf' | 'bin'>[];
  /** Shelf letters known to exist (e.g. from /api/racks). */
  shelves?: string[];
  highlightShelf?: string | null;
  highlightBin?: number | null;
  compact?: boolean;
}

const MIN_BINS = 3;

/**
 * Front view of one rack: shelf A at the top, bins left-to-right.
 * The highlighted shelf/bin is marked with colour *and* a text marker.
 */
export function RackDiagram({ rack, items, shelves = [], highlightShelf, highlightBin, compact = false }: Props) {
  const letters = new Set<string>(shelves);
  for (const it of items) if (it.shelf) letters.add(it.shelf);
  if (highlightShelf) letters.add(highlightShelf);
  const lastShelf = [...letters].sort().pop() ?? 'A';
  const rows = shelfRange(lastShelf);

  let maxBin = MIN_BINS;
  for (const it of items) if (it.bin !== null && it.bin > maxBin) maxBin = it.bin;
  if (highlightBin != null && highlightBin > maxBin) maxBin = highlightBin;
  const bins = Array.from({ length: maxBin }, (_, i) => i + 1);

  const occupied = new Map<string, number>();
  for (const it of items) {
    if (!it.shelf || it.bin === null) continue;
    const key = `${it.shelf}-${it.bin}`;
    occupied.set(key, (occupied.get(key) ?? 0) + 1);
  }

  let summary = `Rack ${rack} has ${rows.length} shelf level${rows.length === 1 ? '' : 's'}, A at the top.`;
  if (highlightShelf) {
    summary += ` Highlighted: shelf ${highlightShelf}${highlightBin != null ? `, bin ${highlightBin}` : ''}.`;
  }

  return (
    <figure className={`rack${compact ? ' rack--compact' : ''}`} data-testid="rack-diagram">
      <figcaption className="visually-hidden">{summary}</figcaption>
      <div className="rack__frame" aria-hidden="true">
        <div className="rack__title">Rack {rack}</div>
        {rows.map((shelf) => {
          const rowHit = shelf === highlightShelf;
          return (
            <div key={shelf} className={`rack__row${rowHit ? ' is-hit' : ''}`} data-shelf={shelf}>
              <span className="rack__label">{shelf}</span>
              <div className="rack__bins" style={{ gridTemplateColumns: `repeat(${bins.length}, minmax(0, 1fr))` }}>
                {bins.map((bin) => {
                  const hit = rowHit && highlightBin === bin;
                  const count = occupied.get(`${shelf}-${bin}`) ?? 0;
                  return (
                    <span
                      key={bin}
                      className={`rack__bin${count ? ' has-items' : ''}${hit ? ' is-hit' : ''}`}
                      data-bin={bin}
                      data-highlighted={hit || undefined}
                    >
                      {hit ? '📍' : bin}
                    </span>
                  );
                })}
              </div>
              {rowHit && <span className="rack__here">◀ here</span>}
            </div>
          );
        })}
      </div>
    </figure>
  );
}

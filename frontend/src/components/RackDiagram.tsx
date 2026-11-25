import { useLayoutEffect, useRef } from 'react';
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
/** Above this many bins we only draw occupied/highlighted bins, with gaps collapsed to "…". */
export const MAX_DRAWN_BINS = 24;

type Column = { kind: 'bin'; bin: number } | { kind: 'gap'; from: number; to: number };

/** Bin columns to draw: 1..maxBin, or a collapsed list when a rack has very many (or a typo'd huge) bin. */
function binColumns(maxBin: number, important: Set<number>): Column[] {
  if (maxBin <= MAX_DRAWN_BINS) {
    return Array.from({ length: maxBin }, (_, i) => ({ kind: 'bin', bin: i + 1 }));
  }
  const keep = [...new Set([1, ...important])].filter((b) => b >= 1).sort((a, b) => a - b);
  const cols: Column[] = [];
  let prev = 0;
  for (const b of keep) {
    if (b > prev + 1) cols.push({ kind: 'gap', from: prev + 1, to: b - 1 });
    cols.push({ kind: 'bin', bin: b });
    prev = b;
  }
  return cols;
}

/**
 * Front view of one rack: shelf A at the top, bins left-to-right.
 * The highlighted shelf/bin is marked with colour *and* a text marker (📍 / "here").
 * Bins keep a minimum width; wide racks scroll sideways inside the diagram and the
 * highlighted bin is scrolled into view.
 */
export function RackDiagram({ rack, items, shelves = [], highlightShelf, highlightBin, compact = false }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const letters = new Set<string>(shelves);
  for (const it of items) if (it.shelf) letters.add(it.shelf);
  if (highlightShelf) letters.add(highlightShelf);
  const lastShelf = [...letters].sort().pop() ?? 'A';
  const rows = shelfRange(lastShelf);

  let maxBin = MIN_BINS;
  const important = new Set<number>();
  for (const it of items) {
    if (it.bin === null) continue;
    important.add(it.bin);
    if (it.bin > maxBin) maxBin = it.bin;
  }
  if (highlightBin != null) {
    important.add(highlightBin);
    if (highlightBin > maxBin) maxBin = highlightBin;
  }
  const columns = binColumns(maxBin, important);

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

  // Keep the highlighted bin visible when the rack is wider than the screen.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const hit = scroller?.querySelector<HTMLElement>('[data-highlighted="true"]');
    if (!scroller || !hit || scroller.scrollWidth <= scroller.clientWidth) return;
    scroller.scrollLeft = Math.max(0, hit.offsetLeft - scroller.clientWidth / 2 + hit.offsetWidth / 2);
  }, [rack, highlightShelf, highlightBin, maxBin]);

  const gridTemplateColumns = columns.map((c) => (c.kind === 'gap' ? 'var(--gap-col)' : 'var(--bin-col)')).join(' ');

  return (
    <figure
      className={`rack${compact ? ' rack--compact' : ''}${highlightShelf ? ' rack--has-hit' : ''}`}
      data-testid="rack-diagram"
    >
      <figcaption className="visually-hidden">{summary}</figcaption>
      <div className="rack__frame" aria-hidden="true">
        <div className="rack__title">Rack {rack}</div>
        <div className="rack__scroll" ref={scrollRef}>
          {rows.map((shelf) => {
            const rowHit = shelf === highlightShelf;
            return (
              <div key={shelf} className={`rack__row${rowHit ? ' is-hit' : ''}`} data-shelf={shelf}>
                <span className="rack__label">{shelf}</span>
                <div className="rack__bins" style={{ gridTemplateColumns }}>
                  {columns.map((col) => {
                    if (col.kind === 'gap') {
                      return (
                        <span key={`gap-${col.from}`} className="rack__gap" title={`Bins ${col.from}–${col.to}`}>
                          …
                        </span>
                      );
                    }
                    const { bin } = col;
                    const hit = rowHit && highlightBin === bin;
                    const count = occupied.get(`${shelf}-${bin}`) ?? 0;
                    return (
                      <span
                        key={bin}
                        className={`rack__bin${count ? ' has-items' : ''}${hit ? ' is-hit' : ''}`}
                        data-bin={bin}
                        data-highlighted={hit || undefined}
                      >
                        {hit ? (
                          <>
                            <span className="rack__pin">📍</span>
                            <span className="rack__hit-num">{bin}</span>
                          </>
                        ) : (
                          bin
                        )}
                      </span>
                    );
                  })}
                </div>
                {highlightShelf && <span className="rack__here">{rowHit ? '◀ here' : ''}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </figure>
  );
}

import { Link, useParams } from 'react-router-dom';
import type { Item } from '../api/types';
import { api } from '../api/client';
import { ConditionChip } from '../components/ConditionChip';
import { ChevronLeftIcon } from '../components/Icons';
import { RackDiagram } from '../components/RackDiagram';
import { EmptyState, ErrorState, Loading, isNotFound } from '../components/StatusViews';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { normalizeRack } from '../lib/location';

export function RackPage() {
  const { rack: rawRack = '' } = useParams();
  const rack = normalizeRack(rawRack) ?? rawRack.toUpperCase();
  useDocumentTitle(`Rack ${rack}`);
  const detail = useAsync((signal) => api.getRack(rack, signal), [rack]);

  const back = (
    <Link to="/map" className="back-link">
      <ChevronLeftIcon /> Map
    </Link>
  );

  if (detail.status === 'loading') {
    return (
      <div className="page">
        {back}
        <Loading label={`Loading rack ${rack}…`} />
      </div>
    );
  }
  if (detail.status === 'error') {
    return (
      <div className="page">
        {back}
        {isNotFound(detail.error) ? (
          <EmptyState title={`Rack ${rack} has no items`} icon="🗺️">
            <p>There is nothing stored on this rack yet, or the rack doesn't exist.</p>
            <Link to="/map" className="btn btn--primary">
              Back to the map
            </Link>
          </EmptyState>
        ) : (
          <ErrorState error={detail.error} title="Couldn't load this rack" onRetry={detail.reload} />
        )}
      </div>
    );
  }

  const shelves = detail.data.shelves;
  const unshelved = detail.data.unshelved ?? [];
  const allItems = [...shelves.flatMap((s) => s.items), ...unshelved];

  return (
    <div className="page page--rack">
      {back}
      <h1 className="page__title">Rack {detail.data.rack}</h1>
      <p className="page__lead">
        {allItems.length} item{allItems.length === 1 ? '' : 's'} · shelf A is the top
      </p>

      <div className="card rack-card">
        <RackDiagram rack={detail.data.rack} items={allItems} shelves={shelves.map((s) => s.shelf)} />
      </div>

      {unshelved.length > 0 && (
        <section className="shelf" aria-labelledby="shelf-none">
          <h2 id="shelf-none" className="shelf__title">
            On this rack, shelf not recorded
            <span className="muted">
              {' '}
              · {unshelved.length} item{unshelved.length === 1 ? '' : 's'}
            </span>
          </h2>
          <ItemList items={unshelved} />
        </section>
      )}

      {shelves.length === 0 && unshelved.length === 0 ? (
        <EmptyState title="Nothing on this rack yet" icon="📦" />
      ) : (
        shelves.map((s) => (
          <section key={s.shelf} className="shelf" aria-labelledby={`shelf-${s.shelf}`}>
            <h2 id={`shelf-${s.shelf}`} className="shelf__title">
              Shelf {s.shelf}
              <span className="muted">
                {' '}
                · {s.items.length} item{s.items.length === 1 ? '' : 's'}
              </span>
            </h2>
            {s.items.length === 0 ? <p className="muted">Empty shelf.</p> : <ItemList items={s.items} />}
          </section>
        ))
      )}
    </div>
  );
}

function ItemList({ items }: { items: Item[] }) {
  return (
    <ul className="shelf__list">
      {items.map((it) => (
        <li key={it.id} className="shelf__item">
          <span className="bin-tag">
            {it.bin !== null ? (
              <>
                <span className="bin-tag__label">Bin</span> {it.bin}
              </>
            ) : (
              <span className="bin-tag__label">No bin</span>
            )}
          </span>
          <span className="shelf__item-main">
            <Link to={`/items/${it.id}`} className="stretched-link shelf__item-name">
              {it.name}
            </Link>
            <span className="shelf__item-sub">
              <span className="code">{it.code}</span> · Qty {it.quantity} {it.unit}
            </span>
          </span>
          <ConditionChip condition={it.condition} />
        </li>
      ))}
    </ul>
  );
}

import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { PageHeading } from '../components/PageHeading';
import { isLeaderCancelled, useLeader } from '../leader/LeaderContext';
import { showFlash } from '../lib/flash';
import { isRootEntry } from '../lib/history';
import type { Item } from '../api/types';
import { ConditionChip } from '../components/ConditionChip';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ChevronLeftIcon } from '../components/Icons';
import { LocationBadge } from '../components/LocationBadge';
import { RackDiagram } from '../components/RackDiagram';
import { EmptyState, ErrorState, Loading, isNotFound, notFoundError } from '../components/StatusViews';
import { StoreMap } from '../components/StoreMap';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function ItemDetailPage() {
  const { id = '' } = useParams();
  const item = useAsync(
    (signal) => (/^\d+$/.test(id) ? api.getItem(id, signal) : Promise.reject(notFoundError())),
    [id],
  );
  useDocumentTitle(item.status === 'success' ? item.data.name : 'Item');

  if (item.status === 'loading') return <Loading label="Loading item…" />;
  if (item.status === 'error') {
    if (isNotFound(item.error)) {
      return (
        <EmptyState title="We couldn't find that item" icon="🧭" pageHeading>
          <p>It may have been deleted, or the link is wrong.</p>
          <Link to="/" className="btn btn--primary">
            Back to search
          </Link>
        </EmptyState>
      );
    }
    return <ErrorState error={item.error} title="Couldn't load this item" onRetry={item.reload} />;
  }
  return <ItemDetail item={item.data} />;
}

function ItemDetail({ item }: { item: Item }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { leader, requireLeader, runAsLeader } = useLeader();

  /** Edit/Delete are always visible; when locked they ask for the PIN first, then continue. */
  function gated(action: () => void) {
    return (e: React.MouseEvent) => {
      if (leader) return action();
      e.preventDefault();
      void requireLeader().then((ok) => ok && action());
    };
  }
  const goEdit = () => navigate(`/items/${item.id}/edit`);

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await runAsLeader(() => api.deleteItem(item.id));
      showFlash(`Deleted “${item.name}” (${item.code}).`);
      // Replace: the deleted item's page must not stay in history (Back would show "not found").
      navigate('/', { replace: true });
    } catch (err) {
      setDeleting(false);
      if (isLeaderCancelled(err)) return; // keep the confirm dialog open
      setConfirmOpen(false);
      setDeleteError(err instanceof Error ? err.message : 'Could not delete the item.');
    }
  }

  return (
    <div className="page page--detail">
      <Link
        to="/"
        className="back-link"
        onClick={(e) => {
          // Prefer real Back (keeps the previous search text) when there is in-app history.
          if (!isRootEntry(location)) {
            e.preventDefault();
            navigate(-1);
          }
        }}
      >
        <ChevronLeftIcon /> Back
      </Link>

      <header className="detail__hero card">
        <div className="detail__heading">
          <span className="code">{item.code}</span>
          <PageHeading className="detail__name">{item.name}</PageHeading>
          <ConditionChip condition={item.condition} />
        </div>
        <div className="detail__loc">
          <LocationBadge
            locationCode={item.locationCode}
            rack={item.rack}
            shelf={item.shelf}
            bin={item.bin}
            size="xl"
            showDescription
          />
        </div>
      </header>

      {deleteError && (
        <div className="alert alert--error" role="alert">
          {deleteError}
        </div>
      )}

      <div className="detail__grid">
        <section className="card" aria-labelledby="where-heading">
          <h2 id="where-heading" className="card__title">
            Where to find it
          </h2>
          {item.rack ? (
            <WhereDiagrams item={item} rack={item.rack} />
          ) : (
            <p className="muted">
              {item.locationCode
                ? `The location “${item.locationCode}” isn't a rack coordinate, so it can't be shown on the map.`
                : 'This item has no location yet.'}{' '}
              <Link to={`/items/${item.id}/edit`}>Add a location like R03-B-2</Link>.
            </p>
          )}
        </section>

        <section className="card" aria-labelledby="details-heading">
          <h2 id="details-heading" className="card__title">
            Details
          </h2>
          <dl className="facts">
            <div>
              <dt>Quantity</dt>
              <dd>
                {item.quantity} {item.unit}
              </dd>
            </div>
            <div>
              <dt>Category</dt>
              <dd>{item.category || <span className="muted">None</span>}</dd>
            </div>
            <div>
              <dt>Condition</dt>
              <dd>
                <ConditionChip condition={item.condition} />
              </dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>{item.locationCode || <span className="muted">Not set</span>}</dd>
            </div>
            {item.brand && (
              <div>
                <dt>Brand</dt>
                <dd>{item.brand}</dd>
              </div>
            )}
            {item.model && (
              <div>
                <dt>Model</dt>
                <dd>{item.model}</dd>
              </div>
            )}
            {item.barcode && (
              <div>
                <dt>Barcode</dt>
                <dd className="code">{item.barcode}</dd>
              </div>
            )}
            <div className="facts__wide">
              <dt>Notes</dt>
              <dd className="pre-wrap">{item.notes || <span className="muted">No notes</span>}</dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>{formatDate(item.updatedAt)}</dd>
            </div>
          </dl>
          <div className="btn-row">
            <Link
              to={`/items/${item.id}/edit`}
              className="btn btn--primary"
              onClick={(e) => {
                if (!leader) gated(goEdit)(e);
              }}
            >
              {!leader && <span aria-hidden="true">🔒 </span>}Edit item
            </Link>
            <button type="button" className="btn btn--danger-outline" onClick={gated(() => setConfirmOpen(true))}>
              {!leader && <span aria-hidden="true">🔒 </span>}
              Delete
            </button>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Delete this item?"
        confirmLabel="Yes, delete"
        danger
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>
          “{item.name}” ({item.code}) will be removed from the store-room list. This can't be undone.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function WhereDiagrams({ item, rack: rackId }: { item: Item; rack: string }) {
  const rack = useAsync((signal) => api.getRack(rackId, signal), [rackId]);
  const racks = useAsync((signal) => api.listRacks(signal), []);

  const rackItems =
    rack.status === 'success' ? [...rack.data.shelves.flatMap((s) => s.items), ...(rack.data.unshelved ?? [])] : [item];
  const shelves = rack.status === 'success' ? rack.data.shelves.map((s) => s.shelf) : [];

  return (
    <div className="where">
      <div className="where__block">
        <h3 className="where__label">
          Rack {rackId} — front view <span className="muted">(shelf A is the top)</span>
        </h3>
        {rack.status === 'loading' ? (
          <Loading label="Loading rack…" />
        ) : (
          <RackDiagram
            rack={rackId}
            items={rackItems}
            shelves={shelves}
            highlightShelf={item.shelf}
            highlightBin={item.bin}
          />
        )}
        {rack.status === 'error' && (
          <p className="inline-error">
            <span aria-hidden="true">⚠ </span>
            Couldn't load the other items on this rack, so only this item is shown.{' '}
            <button type="button" className="link-button" onClick={rack.reload}>
              Try again
            </button>
          </p>
        )}
        {!item.shelf && <p className="muted">The shelf isn't recorded for this item — look along the whole rack.</p>}
        <Link to={`/racks/${encodeURIComponent(rackId)}`} className="text-link">
          See everything on rack {rackId}
        </Link>
      </div>
      <div className="where__block">
        <h3 className="where__label">Store-room map</h3>
        {racks.status === 'loading' && <Loading label="Loading map…" />}
        {racks.status === 'error' && (
          <ErrorState error={racks.error} title="Couldn't load the map" onRetry={racks.reload} />
        )}
        {racks.status === 'success' && <StoreMap racks={racks.data.racks} highlightRack={rackId} compact />}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

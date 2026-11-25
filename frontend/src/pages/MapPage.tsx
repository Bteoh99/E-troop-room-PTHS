import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { EmptyState, ErrorState, Loading } from '../components/StatusViews';
import { StoreMap } from '../components/StoreMap';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function MapPage() {
  useDocumentTitle('Store-room map');
  const racks = useAsync((signal) => api.listRacks(signal), []);

  return (
    <div className="page page--map">
      <h1 className="page__title">Store-room map</h1>
      <p className="page__lead">Tap a rack to see what is on each shelf.</p>

      {racks.status === 'loading' && <Loading label="Loading map…" />}
      {racks.status === 'error' && (
        <ErrorState error={racks.error} title="Couldn't load the map" onRetry={racks.reload} />
      )}
      {racks.status === 'success' &&
        (racks.data.racks.length === 0 ? (
          <EmptyState title="No racks yet" icon="🗺️">
            <p>Racks appear here once items have a location like R03-B-2.</p>
            <Link to="/items/new" className="btn btn--primary">
              Add an item
            </Link>
          </EmptyState>
        ) : (
          <>
            <StoreMap racks={racks.data.racks} />
            {racks.data.unlocated > 0 && (
              <p className="note">
                <span aria-hidden="true">ℹ️ </span>
                {racks.data.unlocated} item{racks.data.unlocated === 1 ? ' has' : 's have'} no rack location yet, so{' '}
                {racks.data.unlocated === 1 ? 'it is' : 'they are'} not on the map.
              </p>
            )}
          </>
        ))}
    </div>
  );
}

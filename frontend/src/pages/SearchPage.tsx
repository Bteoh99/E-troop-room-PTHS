import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { ItemCard } from '../components/ItemCard';
import { CameraIcon, SearchIcon } from '../components/Icons';
import { PageHeading } from '../components/PageHeading';
import { EmptyState, ErrorState, Loading } from '../components/StatusViews';
import { useAsync } from '../hooks/useAsync';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export const SEARCH_DEBOUNCE_MS = 200;

export function SearchPage() {
  useDocumentTitle(null);
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  const [text, setText] = useState(urlQuery);
  const category = params.get('category') ?? '';
  const query = useDebouncedValue(text.trim(), SEARCH_DEBOUNCE_MS);
  const inputId = useId();
  const catId = useId();
  /** The q value most recently written to / read from the URL. */
  const syncedQuery = useRef(urlQuery);

  const location = useLocation();
  /** True while the next location change is one this page made itself (typing, category). */
  const selfNavigation = useRef(false);

  // URL -> box on every navigation this page didn't make (Search tab, logo, Back/Forward).
  // Keyed on location.key (not on ?q=) so clicking the Search tab on "/" also clears text that is
  // still waiting for the debounce; resetting the text restarts the debounce with the URL's value.
  useEffect(() => {
    if (selfNavigation.current) {
      selfNavigation.current = false;
      return;
    }
    syncedQuery.current = urlQuery;
    setText(urlQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // Box -> URL (debounced), so Back from an item returns to the same search.
  // setParams changes identity on every URL change, so read it from a ref: this must run only when `query` changes.
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  useEffect(() => {
    if (query === syncedQuery.current) return;
    syncedQuery.current = query;
    selfNavigation.current = true;
    setParamsRef.current(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (query) next.set('q', query);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [query]);

  const results = useAsync(
    (signal) => api.listItems({ q: query || undefined, category: category || undefined }, signal),
    [query, category],
  );
  const categories = useAsync((signal) => api.listCategories(signal), []);
  const racks = useAsync((signal) => api.listRacks(signal), []);
  const unlocated = racks.status === 'success' && racks.data ? (racks.data.unlocated ?? 0) : 0;

  function setCategory(value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set('category', value);
    else next.delete('category');
    selfNavigation.current = true;
    setParams(next, { replace: true });
  }

  const items = results.data ?? [];
  const isSearching = query !== '' || category !== '';
  const stale = results.status === 'loading' && results.data !== undefined;

  return (
    <div className="page page--search">
      <PageHeading>Find an item</PageHeading>
      <form className="search" role="search" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor={inputId} className="visually-hidden">
          Search by item name, code or location
        </label>
        <div className="search__box">
          <SearchIcon className="search__icon" />
          <input
            id={inputId}
            type="search"
            className="search__input"
            placeholder="Tent, TNT-004, R03…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
          />
          <Link to="/scan" className="search__scan" aria-label="Scan a label or barcode with the camera" title="Scan">
            <CameraIcon />
          </Link>
        </div>
        <div className="search__filters">
          <label htmlFor={catId}>Category</label>
          <select id={catId} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {/* A category from the URL that the list doesn't (or doesn't yet) contain still shows as selected. */}
            {category && !(categories.data ?? []).some((c) => c.name === category) && (
              <option value={category}>
                {category}
                {categories.status === 'success' ? ' (0)' : ''}
              </option>
            )}
            {(categories.data ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.count})
              </option>
            ))}
          </select>
        </div>
      </form>

      {unlocated > 0 && (
        <Link to="/locate" className="todo-badge" data-testid="unlocated-badge">
          <span className="todo-badge__count">{unlocated}</span>{' '}
          <span>
            item{unlocated === 1 ? ' needs' : 's need'} a location <span aria-hidden="true">→</span>
          </span>
        </Link>
      )}

      <p className="visually-hidden" role="status" aria-live="polite">
        {results.status === 'success'
          ? `${items.length} item${items.length === 1 ? '' : 's'} found`
          : results.status === 'loading'
            ? 'Searching'
            : ''}
      </p>

      {results.status === 'error' && (
        <ErrorState error={results.error} title="Couldn't load items" onRetry={results.reload} />
      )}

      {results.status === 'loading' && results.data === undefined && <Loading label="Loading items…" />}

      {results.data !== undefined && results.status !== 'error' && (
        <section aria-label="Results" className={stale ? 'is-stale' : undefined} aria-busy={stale}>
          {items.length > 0 ? (
            <>
              <p className="results__count">
                {isSearching ? `${items.length} match${items.length === 1 ? '' : 'es'}` : `All items (${items.length})`}
              </p>
              <ul className="results">
                {items.map((item) => (
                  <li key={item.id}>
                    <ItemCard item={item} />
                  </li>
                ))}
              </ul>
            </>
          ) : isSearching ? (
            <EmptyState title={query ? `No items match “${query}”` : 'No items in this category'} icon="🔎">
              <p>Try a shorter word, a different spelling, or a rack code like R03.</p>
              <Link to="/items/new" className="btn btn--secondary">
                Add a new item
              </Link>
            </EmptyState>
          ) : (
            <EmptyState title="The store room is empty">
              <p>Add your first item, or import the inventory spreadsheet.</p>
              <div className="btn-row">
                <Link to="/items/new" className="btn btn--primary">
                  Add an item
                </Link>
                <Link to="/import" className="btn btn--secondary">
                  Import from Excel
                </Link>
              </div>
            </EmptyState>
          )}
        </section>
      )}
    </div>
  );
}

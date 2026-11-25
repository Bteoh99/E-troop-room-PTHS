import { useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { ItemCard } from '../components/ItemCard';
import { SearchIcon } from '../components/Icons';
import { EmptyState, ErrorState, Loading } from '../components/StatusViews';
import { useAsync } from '../hooks/useAsync';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export const SEARCH_DEBOUNCE_MS = 200;

export function SearchPage() {
  useDocumentTitle(null);
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(() => params.get('q') ?? '');
  const category = params.get('category') ?? '';
  const query = useDebouncedValue(text.trim(), SEARCH_DEBOUNCE_MS);
  const inputId = useId();
  const catId = useId();

  // Keep the URL in sync (so Back from an item returns to the same search).
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (query) next.set('q', query);
    else next.delete('q');
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [query, params, setParams]);

  const results = useAsync(
    (signal) => api.listItems({ q: query || undefined, category: category || undefined }, signal),
    [query, category],
  );
  const categories = useAsync((signal) => api.listCategories(signal), []);

  function setCategory(value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set('category', value);
    else next.delete('category');
    setParams(next, { replace: true });
  }

  const items = results.data ?? [];
  const isSearching = query !== '' || category !== '';
  const stale = results.status === 'loading' && results.data !== undefined;

  return (
    <div className="page page--search">
      <h1 className="page__title">Find an item</h1>
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
            placeholder="Search tent, TNT-004, R03…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
          />
        </div>
        <div className="search__filters">
          <label htmlFor={catId}>Category</label>
          <select id={catId} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {(categories.data ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.count})
              </option>
            ))}
          </select>
        </div>
      </form>

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

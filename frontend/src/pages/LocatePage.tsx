import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Item } from '../api/types';
import { LocationBadge } from '../components/LocationBadge';
import { PageHeading } from '../components/PageHeading';
import { EmptyState, ErrorState, Loading } from '../components/StatusViews';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { isLeaderCancelled, useLeader } from '../leader/LeaderContext';
import { describeLocation, normalizeRack, parseLocation } from '../lib/location';
import { announce } from '../lib/routeFocus';

const LEAVE_MS = 250;
const MAX_LOCATION = 100;

/**
 * Applies the optional rack prefix: with prefix R03, typing "B-2" means "R03-B-2".
 * Text that already starts with a rack ("R04-A-1", "4 A 1", "Rack 4") is used as typed.
 */
export function withRackPrefix(prefix: string, typed: string): string {
  const t = typed.trim();
  const rack = normalizeRack(prefix);
  if (!rack || !t) return t;
  if (/^(?:RACK|RAK|R)?[\s\-/._]*\d/i.test(t)) return t;
  return `${rack}-${t}`;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

export function LocatePage() {
  useDocumentTitle('Needs a location');
  const { leader, unlock, runAsLeader } = useLeader();
  const list = useAsync((signal) => api.listUnlocated(signal), []);
  const [items, setItems] = useState<Item[] | null>(null);
  const [values, setValues] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [leaving, setLeaving] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState<number | null>(null);
  const [prefix, setPrefix] = useState('');
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const timers = useRef<number[]>([]);
  const prefixId = useId();
  const uid = useId();

  useEffect(() => {
    if (list.status === 'success') setItems(list.data);
  }, [list.status, list.data]);

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const prefixRack = normalizeRack(prefix);
  const prefixInvalid = prefix.trim() !== '' && !prefixRack;

  async function save(e: FormEvent, item: Item) {
    e.preventDefault();
    if (!items) return;
    const combined = withRackPrefix(prefix, values[item.id] ?? '');
    const loc = parseLocation(combined);
    let problem: string | null = null;
    if (!combined) problem = 'Type a location first, e.g. R03-B-2.';
    else if (combined.length > MAX_LOCATION) problem = `A location can be at most ${MAX_LOCATION} characters.`;
    else if (!loc.parsed) problem = `“${combined}” isn't a rack coordinate. Use a format like R03-B-2.`;
    if (problem) {
      setErrors((prev) => ({ ...prev, [item.id]: problem }));
      inputs.current.get(item.id)?.focus();
      return;
    }

    setSaving(item.id);
    try {
      await runAsLeader(() => api.updateItem(item.id, { locationCode: loc.locationCode }));
    } catch (err) {
      setSaving(null);
      if (isLeaderCancelled(err)) return;
      setErrors((prev) => ({ ...prev, [item.id]: err instanceof Error ? err.message : 'Could not save.' }));
      return;
    }
    setSaving(null);

    // Jump straight to the next item's box so a leader can keep walking the racks.
    const visible = items.filter((i) => !leaving.has(i.id));
    const index = visible.findIndex((i) => i.id === item.id);
    const next = visible[index + 1] ?? visible[index - 1];
    if (next) inputs.current.get(next.id)?.focus();
    announce(`Saved ${item.code} at ${loc.locationCode}.${next ? ` Next: ${next.name}.` : ''}`);

    setLeaving((prev) => new Set(prev).add(item.id));
    const remove = () => {
      setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? prev);
      setLeaving((prev) => {
        const n = new Set(prev);
        n.delete(item.id);
        return n;
      });
    };
    if (prefersReducedMotion()) remove();
    else timers.current.push(window.setTimeout(remove, LEAVE_MS));
  }

  return (
    <div className="page page--locate">
      <Link to="/map" className="back-link">
        ‹ Map
      </Link>
      <PageHeading>Needs a location</PageHeading>
      <p className="page__lead">
        Walk along the racks and type where each item is. Press Enter (or Save) and the next box is ready.
      </p>

      {!leader && (
        <p className="note">
          <span aria-hidden="true">🔒 </span>Saving locations needs the leader PIN.{' '}
          <button type="button" className="link-button" onClick={unlock}>
            Unlock
          </button>
        </p>
      )}

      <div className="field locate-prefix">
        <label htmlFor={prefixId}>Rack prefix (optional)</label>
        <input
          id={prefixId}
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          placeholder="e.g. R03"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-describedby={`${prefixId}-hint`}
          aria-invalid={prefixInvalid ? true : undefined}
        />
        <p id={`${prefixId}-hint`} className={prefixInvalid ? 'field__error' : 'field__hint'}>
          {prefixInvalid
            ? 'That isn’t a rack. Rack names look like R03.'
            : prefixRack
              ? `Working on rack ${prefixRack}: type just the shelf and bin, like B-2.`
              : 'Set a rack once, then type just the shelf and bin (like B-2) for each item.'}
        </p>
      </div>

      {list.status === 'loading' && <Loading label="Loading items…" />}
      {list.status === 'error' && (
        <ErrorState error={list.error} title="Couldn't load the list" onRetry={list.reload} />
      )}

      {items &&
        (items.length === 0 ? (
          <EmptyState title="Every item has a location" icon="🎉">
            <p>Nothing left to do here.</p>
            <Link to="/map" className="btn btn--primary">
              View the map
            </Link>
          </EmptyState>
        ) : (
          <>
            <p className="results__count">
              {items.length} item{items.length === 1 ? '' : 's'} need{items.length === 1 ? 's' : ''} a location
            </p>
            <ul className="locate-list" data-testid="locate-list">
              {items.map((item) => {
                const id = `${uid}-${item.id}`;
                const typed = values[item.id] ?? '';
                const combined = withRackPrefix(prefix, typed);
                const loc = parseLocation(combined);
                const err = errors[item.id];
                return (
                  <li
                    key={item.id}
                    className={`card locate-row${leaving.has(item.id) ? ' is-leaving' : ''}`}
                    data-testid="locate-row"
                  >
                    <div className="locate-row__info">
                      <span className="code">{item.code}</span>
                      <span className="locate-row__name">{item.name}</span>
                      <span className="muted">
                        Qty {item.quantity} {item.unit}
                      </span>
                      {item.locationCode && <span className="muted">Now: “{item.locationCode}”</span>}
                    </div>
                    <form className="locate-row__form" onSubmit={(e) => void save(e, item)} noValidate>
                      <label htmlFor={id} className="visually-hidden">
                        Location for {item.name} ({item.code})
                      </label>
                      <input
                        id={id}
                        ref={(el) => {
                          if (el) inputs.current.set(item.id, el);
                          else inputs.current.delete(item.id);
                        }}
                        value={typed}
                        onChange={(e) => {
                          setValues((prev) => ({ ...prev, [item.id]: e.target.value }));
                          if (errors[item.id]) setErrors(({ [item.id]: _drop, ...rest }) => rest);
                        }}
                        placeholder={prefixRack ? 'e.g. B-2' : 'e.g. R03-B-2'}
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        enterKeyHint="next"
                        aria-invalid={err ? true : undefined}
                        aria-describedby={`${id}-preview`}
                        disabled={leaving.has(item.id)}
                      />
                      <button
                        type="submit"
                        className="btn btn--primary"
                        disabled={saving === item.id || leaving.has(item.id)}
                      >
                        {saving === item.id ? 'Saving…' : 'Save'}
                      </button>
                    </form>
                    <div id={`${id}-preview`} className="locate-row__preview" aria-live="polite">
                      {err ? (
                        <p className="field__error">
                          <span aria-hidden="true">⚠ </span>
                          {err}
                        </p>
                      ) : loc.parsed ? (
                        <>
                          <LocationBadge
                            locationCode={loc.locationCode}
                            rack={loc.rack}
                            shelf={loc.shelf}
                            bin={loc.bin}
                            size="md"
                          />
                          <span className="loc-preview__desc">{describeLocation(loc)}</span>
                        </>
                      ) : combined ? (
                        <p className="field__warn">
                          <span aria-hidden="true">⚠ </span>Not a rack coordinate yet — e.g. R03-B-2
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        ))}
    </div>
  );
}

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { CONDITIONS, type Condition, type Item, type ItemInput } from '../api/types';
import { ChevronLeftIcon } from '../components/Icons';
import { LocationBadge } from '../components/LocationBadge';
import { PageHeading } from '../components/PageHeading';
import { EmptyState, ErrorState, Loading, isNotFound, notFoundError } from '../components/StatusViews';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { CONDITION_LABELS } from '../lib/conditions';
import { showFlash } from '../lib/flash';
import { isRootEntry, replaceState } from '../lib/history';
import { describeLocation, parseLocation } from '../lib/location';

export interface FormValues {
  code: string;
  name: string;
  category: string;
  location: string;
  quantity: string;
  unit: string;
  condition: Condition;
  notes: string;
}

type FieldName = keyof FormValues;
type FieldErrors = Partial<Record<FieldName, string>>;

const EMPTY: FormValues = {
  code: '',
  name: '',
  category: '',
  location: '',
  quantity: '1',
  unit: 'pcs',
  condition: 'good',
  notes: '',
};

function fromItem(item: Item): FormValues {
  return {
    code: item.code,
    name: item.name,
    category: item.category ?? '',
    location: item.locationCode ?? '',
    quantity: String(item.quantity),
    unit: item.unit,
    condition: item.condition,
    notes: item.notes ?? '',
  };
}

/** Mirrors the backend limits (backend/src/lib/itemSchema.js LIMITS). */
export const LIMITS = {
  code: 50,
  name: 200,
  category: 100,
  location: 100,
  unit: 30,
  notes: 2000,
  quantity: 1_000_000,
} as const;

const FIELD_LABELS: Record<FieldName, string> = {
  code: 'Item code',
  name: 'Name',
  category: 'Category',
  location: 'Location',
  quantity: 'Quantity',
  unit: 'Unit',
  condition: 'Condition',
  notes: 'Notes',
};

/** Form order, used to list errors in the summary in the order the fields appear. */
const FIELD_ORDER: FieldName[] = ['code', 'name', 'location', 'category', 'condition', 'quantity', 'unit', 'notes'];

const QUANTITY_RULE = `Quantity must be a whole number from 0 to ${LIMITS.quantity.toLocaleString('en')}.`;

function tooLong(field: keyof typeof LIMITS): string {
  return `${FIELD_LABELS[field as FieldName]} can be at most ${LIMITS[field].toLocaleString('en')} characters.`;
}

export function validate(values: FormValues): FieldErrors {
  const errors: FieldErrors = {};
  const code = values.code.trim();
  if (!code) errors.code = 'Please enter an item code, e.g. TNT-004.';
  else if (code.length > LIMITS.code) errors.code = tooLong('code');
  const name = values.name.trim();
  if (!name) errors.name = 'Please enter a name, e.g. 4-man dome tent.';
  else if (name.length > LIMITS.name) errors.name = tooLong('name');
  if ((parseLocation(values.location).locationCode ?? '').length > LIMITS.location)
    errors.location = tooLong('location');
  if (values.category.trim().length > LIMITS.category) errors.category = tooLong('category');
  const q = values.quantity.trim();
  if (q === '') errors.quantity = 'Please enter a quantity (0 or more).';
  else if (!/^\d+$/.test(q)) errors.quantity = 'Quantity must be a whole number, 0 or more.';
  else if (Number(q) > LIMITS.quantity) errors.quantity = QUANTITY_RULE;
  if (values.unit.trim().length > LIMITS.unit) errors.unit = tooLong('unit');
  if (values.notes.trim().length > LIMITS.notes) errors.notes = tooLong('notes');
  return errors;
}

export function toInput(values: FormValues): ItemInput {
  const loc = parseLocation(values.location);
  return {
    code: values.code.trim().toUpperCase(),
    name: values.name.trim(),
    category: values.category.trim() || null,
    locationCode: loc.locationCode,
    quantity: Number(values.quantity.trim()),
    unit: values.unit.trim() || 'pcs',
    condition: values.condition,
    notes: values.notes.trim(),
  };
}

const KNOWN_FIELDS: Record<string, FieldName> = {
  code: 'code',
  name: 'name',
  category: 'category',
  locationCode: 'location',
  location: 'location',
  quantity: 'quantity',
  unit: 'unit',
  condition: 'condition',
  notes: 'notes',
};

/** Raw validator wording ("Too big: expected string to have <=100 characters") that users shouldn't see. */
const RAW_VALIDATOR_TEXT = /expected|received|invalid (input|option|type)|too (big|small)|[<>]=|^required$/i;

/** Turn a backend validation message into friendly wording for that field. */
export function friendlyServerMessage(field: FieldName, message: string): string {
  if (!RAW_VALIDATOR_TEXT.test(message)) return message; // backend's own messages are already friendly
  if (field === 'quantity') return QUANTITY_RULE;
  if (field === 'condition') return 'Please choose a condition from the list.';
  if (field in LIMITS && /too big|<=|at most|max/i.test(message)) return tooLong(field as keyof typeof LIMITS);
  if ((field === 'code' || field === 'name') && /too small|>=|required/i.test(message)) {
    return `Please enter ${field === 'code' ? 'an item code' : 'a name'}.`;
  }
  return `Please check the ${FIELD_LABELS[field].toLowerCase()}.`;
}

/** Best-effort mapping of server validation details (zod-style issues or {field: msg}) to fields. */
export function serverFieldErrors(details: unknown): FieldErrors {
  const out: FieldErrors = {};
  const put = (key: unknown, msg: unknown) => {
    const field = typeof key === 'string' ? KNOWN_FIELDS[key] : undefined;
    if (field && typeof msg === 'string' && !out[field]) out[field] = friendlyServerMessage(field, msg);
  };
  if (Array.isArray(details)) {
    for (const issue of details) {
      if (issue && typeof issue === 'object') {
        const { path, message, field } = issue as { path?: unknown; message?: unknown; field?: unknown };
        const key = Array.isArray(path) ? path[0] : typeof path === 'string' ? path.split('.')[0] : field;
        put(key, message);
      }
    }
  } else if (details && typeof details === 'object') {
    const obj = details as Record<string, unknown>;
    const fieldErrors = (obj.fieldErrors ?? obj) as Record<string, unknown>;
    for (const [key, val] of Object.entries(fieldErrors)) {
      put(key, Array.isArray(val) ? val[0] : val);
    }
  }
  return out;
}

export function ItemFormPage() {
  const { id } = useParams();
  const editing = id !== undefined;
  useDocumentTitle(editing ? 'Edit item' : 'Add item');
  const item = useAsync<Item | null>(
    (signal) =>
      !editing ? Promise.resolve(null) : /^\d+$/.test(id) ? api.getItem(id, signal) : Promise.reject(notFoundError()),
    [id],
  );

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
  // key forces a fresh form when switching between items / new.
  return <ItemForm key={id ?? 'new'} item={item.data} />;
}

function ItemForm({ item }: { item: Item | null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [values, setValues] = useState<FormValues>(() => (item ? fromItem(item) : EMPTY));
  const [submitted, setSubmitted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const categories = useAsync((signal) => api.listCategories(signal), []);
  const uid = useId();
  const fid = (f: FieldName) => `${uid}-${f}`;

  const loc = parseLocation(values.location);
  // Client-side errors show live once the user has tried to submit; server errors stay until that field is edited.
  const errors: FieldErrors = { ...serverErrors, ...(submitted ? validate(values) : {}) };

  // Move focus to the error summary after a failed submit so screen-reader users hear it.
  useEffect(() => {
    if (attempt > 0) summaryRef.current?.focus();
  }, [attempt]);

  function set<K extends FieldName>(field: K, value: FormValues[K]) {
    setValues((prev) => ({ ...prev, [field]: value }));
    if (serverErrors[field]) {
      setServerErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setFormError(null);
    setServerErrors({});
    if (Object.keys(validate(values)).length > 0) {
      setAttempt((n) => n + 1);
      return;
    }

    setSaving(true);
    try {
      const input = toInput(values);
      const saved = item ? await api.updateItem(item.id, input) : await api.createItem(input);
      showFlash(item ? 'Changes saved.' : `Added “${saved.name}”.`);
      if (item && !isRootEntry(location)) {
        // The edit form is opened from the item's page: return to that history entry so Back
        // from the item goes where the user came from (e.g. their search), not to this form.
        navigate(-1);
      } else {
        // New item (or edit opened directly): replace the form so it never stays in history.
        navigate(`/items/${saved.id}`, { replace: true, state: replaceState(location) });
      }
    } catch (err) {
      setSaving(false);
      if (err instanceof ApiError && err.status === 409) {
        setServerErrors({ code: 'Another item already uses this code. Please choose a different one.' });
        setFormError('That item code is already taken.');
      } else if (err instanceof ApiError && err.status === 400) {
        const mapped = serverFieldErrors(err.details);
        setServerErrors(mapped);
        setFormError(
          Object.keys(mapped).length > 0
            ? 'Please fix the highlighted fields.'
            : err.message || 'Please check the form.',
        );
      } else {
        setFormError(err instanceof Error ? err.message : 'Could not save the item.');
      }
      setAttempt((n) => n + 1);
    }
  }

  const errorList = FIELD_ORDER.filter((f) => errors[f]).map((f) => [f, errors[f] as string] as const);

  /** Back/Cancel on the edit form: return to the item's existing history entry instead of pushing a new one. */
  const backToItem = (e: React.MouseEvent) => {
    if (item && !isRootEntry(location)) {
      e.preventDefault();
      navigate(-1);
    }
  };

  /** Summary links move focus to the field without adding a #hash history entry. */
  const focusField = (e: React.MouseEvent, f: FieldName) => {
    e.preventDefault();
    document.getElementById(fid(f))?.focus();
  };
  const describedBy = (f: FieldName, ...extra: string[]) =>
    [errors[f] ? `${fid(f)}-err` : '', ...extra].filter(Boolean).join(' ') || undefined;

  const fieldError = (f: FieldName) =>
    errors[f] ? (
      <p id={`${fid(f)}-err`} className="field__error">
        <span aria-hidden="true">⚠ </span>
        {errors[f]}
      </p>
    ) : null;

  return (
    <div className="page page--form">
      <Link to={item ? `/items/${item.id}` : '/'} className="back-link" onClick={backToItem}>
        <ChevronLeftIcon /> {item ? 'Back to item' : 'Back to search'}
      </Link>
      <PageHeading>{item ? `Edit ${item.code}` : 'Add an item'}</PageHeading>

      {(formError || errorList.length > 0) && (
        <div ref={summaryRef} tabIndex={-1} className="alert alert--error" role="alert">
          <p className="alert__title">{formError ?? 'Please fix the following:'}</p>
          {errorList.length > 0 && (
            <ul>
              {errorList.map(([f, msg]) => (
                <li key={f}>
                  <a href={`#${fid(f)}`} onClick={(e) => focusField(e, f)}>
                    {msg}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <form className="card form" onSubmit={onSubmit} noValidate>
        <div className="form__grid">
          <div className="field">
            <label htmlFor={fid('code')}>
              Item code <span className="req">(required)</span>
            </label>
            <input
              id={fid('code')}
              value={values.code}
              onChange={(e) => set('code', e.target.value)}
              aria-invalid={errors.code ? true : undefined}
              aria-describedby={describedBy('code', `${fid('code')}-hint`)}
              autoCapitalize="characters"
              autoComplete="off"
              required
            />
            <p id={`${fid('code')}-hint`} className="field__hint">
              Unique label on the item, e.g. TNT-004. Saved in capitals.
            </p>
            {fieldError('code')}
          </div>

          <div className="field">
            <label htmlFor={fid('name')}>
              Name <span className="req">(required)</span>
            </label>
            <input
              id={fid('name')}
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={describedBy('name')}
              autoComplete="off"
              required
            />
            {fieldError('name')}
          </div>

          <div className="field field--wide field--location">
            <label htmlFor={fid('location')}>Location</label>
            <input
              id={fid('location')}
              value={values.location}
              onChange={(e) => set('location', e.target.value)}
              aria-invalid={errors.location ? true : undefined}
              aria-describedby={describedBy('location', `${fid('location')}-preview`)}
              placeholder="e.g. R03-B-2"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
            />
            {fieldError('location')}
            <div
              id={`${fid('location')}-preview`}
              className="loc-preview"
              aria-live="polite"
              data-testid="location-preview"
            >
              {loc.locationCode === null ? (
                <p className="field__hint">
                  Optional. Rack – shelf – bin, e.g. <strong>R03-B-2</strong> = Rack 03, Shelf B (A is the top), Bin 2.
                </p>
              ) : loc.parsed ? (
                <>
                  <span className="loc-preview__label">Will be saved as</span>
                  <LocationBadge
                    locationCode={loc.locationCode}
                    rack={loc.rack}
                    shelf={loc.shelf}
                    bin={loc.bin}
                    size="md"
                  />
                  <span className="loc-preview__desc">{describeLocation(loc)}</span>
                </>
              ) : (
                <p className="field__warn">
                  <span aria-hidden="true">⚠ </span>“{loc.locationCode}” isn't a rack coordinate. It will be saved
                  exactly as typed but won't show on the map. Use a format like R03-B-2.
                </p>
              )}
            </div>
          </div>

          <div className="field">
            <label htmlFor={fid('category')}>Category</label>
            <input
              id={fid('category')}
              value={values.category}
              onChange={(e) => set('category', e.target.value)}
              list={`${fid('category')}-list`}
              placeholder="e.g. Tents"
              autoComplete="off"
              aria-invalid={errors.category ? true : undefined}
              aria-describedby={describedBy('category')}
            />
            {fieldError('category')}
            <datalist id={`${fid('category')}-list`}>
              {(categories.data ?? []).map((c) => (
                <option key={c.name} value={c.name} />
              ))}
            </datalist>
          </div>

          <div className="field">
            <label htmlFor={fid('condition')}>Condition</label>
            <select
              id={fid('condition')}
              value={values.condition}
              onChange={(e) => set('condition', e.target.value as Condition)}
              aria-invalid={errors.condition ? true : undefined}
              aria-describedby={describedBy('condition')}
            >
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {CONDITION_LABELS[c]}
                </option>
              ))}
            </select>
            {fieldError('condition')}
          </div>

          <div className="field field--qty">
            <label htmlFor={fid('quantity')}>Quantity</label>
            <input
              id={fid('quantity')}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={values.quantity}
              onChange={(e) => set('quantity', e.target.value)}
              aria-invalid={errors.quantity ? true : undefined}
              aria-describedby={describedBy('quantity')}
            />
            {fieldError('quantity')}
          </div>

          <div className="field field--qty">
            <label htmlFor={fid('unit')}>Unit</label>
            <input
              id={fid('unit')}
              value={values.unit}
              onChange={(e) => set('unit', e.target.value)}
              placeholder="pcs"
              autoComplete="off"
              aria-invalid={errors.unit ? true : undefined}
              aria-describedby={describedBy('unit')}
            />
            {fieldError('unit')}
          </div>

          <div className="field field--wide">
            <label htmlFor={fid('notes')}>Notes</label>
            <textarea
              id={fid('notes')}
              rows={3}
              value={values.notes}
              onChange={(e) => set('notes', e.target.value)}
              aria-invalid={errors.notes ? true : undefined}
              aria-describedby={describedBy('notes')}
            />
            {fieldError('notes')}
          </div>
        </div>

        <div className="btn-row form__actions">
          <button type="submit" className="btn btn--primary btn--lg" disabled={saving}>
            {saving ? 'Saving…' : item ? 'Save changes' : 'Add item'}
          </button>
          <Link to={item ? `/items/${item.id}` : '/'} className="btn btn--secondary btn--lg" onClick={backToItem}>
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

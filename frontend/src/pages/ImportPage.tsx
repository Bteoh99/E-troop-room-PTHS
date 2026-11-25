import { useId, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import type { ImportPreviewRow, ImportResult, ImportRowError } from '../api/types';
import { PageHeading } from '../components/PageHeading';
import { Loading } from '../components/StatusViews';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { conditionLabel } from '../lib/conditions';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const ACCEPT = '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';

type Step =
  | { kind: 'choose'; problem?: string }
  | { kind: 'checking'; file: File }
  | { kind: 'preview'; file: File; result: ImportResult }
  | { kind: 'importing'; file: File; result: ImportResult }
  | { kind: 'done'; result: ImportResult }
  | { kind: 'error'; file: File; error: Error; during: 'check' | 'import'; result?: ImportResult };

export function checkFile(file: File): string | null {
  if (!/\.(xlsx|csv)$/i.test(file.name)) return 'Please choose an Excel (.xlsx) or CSV (.csv) file.';
  if (file.size > MAX_IMPORT_BYTES) return 'That file is bigger than 5 MB. Please split it or remove unused sheets.';
  return null;
}

export function isWarning(e: ImportRowError): boolean {
  return /^\s*warning\b/i.test(e.message);
}

export function splitProblems(result: ImportResult): { problems: ImportRowError[]; warnings: ImportRowError[] } {
  const problems: ImportRowError[] = [];
  const warnings: ImportRowError[] = [];
  for (const e of result.errors) (isWarning(e) ? warnings : problems).push(e);
  return { problems, warnings };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter((v) => v.trim() !== '') : [];
}

/** Turn an import API error into friendly wording for non-technical users. */
export function describeImportError(err: Error): { message: string; hints: string[] } {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return { message: 'Another import is running — please try again in a moment.', hints: [] };
    }
    if (err.status === 413) {
      return { message: 'That file is bigger than 5 MB. Please split it or remove unused sheets.', hints: [] };
    }
    const details = (err.details ?? {}) as { missingColumns?: unknown; headersFound?: unknown };
    const missing = stringList(details.missingColumns);
    if (err.status === 400 && missing.length > 0) {
      const found = stringList(details.headersFound);
      return {
        message: `We couldn't find the ${missing.join(' and ')} column${missing.length === 1 ? '' : 's'} in your file.`,
        hints: [
          found.length > 0 ? `Column headings we found: ${found.join(', ')}.` : 'We could not find a heading row.',
          'Rename the headings to match the template (for example "Code" and "Name"), then try again.',
        ],
      };
    }
  }
  return { message: err.message, hints: [] };
}

/** The chosen file could no longer be read (changed, moved or deleted after it was picked). */
export class FileReadError extends Error {
  constructor() {
    super(
      "We couldn't read that file. It may have been changed, moved or renamed after you picked it. Please choose it again.",
    );
    this.name = 'FileReadError';
  }
}

/** Resolves false when the browser can no longer read the picked file. */
export function canReadFile(file: Blob): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(true);
      reader.onerror = () => resolve(false);
      reader.readAsArrayBuffer(file.slice(0, 1));
    } catch {
      resolve(false);
    }
  });
}

/**
 * A failed upload of a file that changed on disk looks like a network error (status 0).
 * Tell those apart so the user gets the right advice.
 */
async function explainUploadError(err: unknown, file: File): Promise<Error> {
  if (err instanceof ApiError && err.status === 0 && !(await canReadFile(file))) return new FileReadError();
  return toError(err);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ImportPage() {
  useDocumentTitle('Import');
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();

  async function runCheck(file: File) {
    setStep({ kind: 'checking', file });
    try {
      const result = await api.importFile(file, true);
      setStep({ kind: 'preview', file, result });
    } catch (err) {
      setStep({ kind: 'error', file, error: await explainUploadError(err, file), during: 'check' });
    }
  }

  async function runImport(file: File, preview: ImportResult) {
    setStep({ kind: 'importing', file, result: preview });
    try {
      const result = await api.importFile(file, false);
      setStep({ kind: 'done', result });
    } catch (err) {
      setStep({ kind: 'error', file, error: await explainUploadError(err, file), during: 'import', result: preview });
    }
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Always clear the input, so picking the same (e.g. just-edited) file again fires "change" again.
    e.target.value = '';
    if (!file) return;
    const problem = checkFile(file);
    if (problem) {
      setStep({ kind: 'choose', problem });
      return;
    }
    void runCheck(file);
  }

  function reset() {
    setStep({ kind: 'choose' });
    if (inputRef.current) inputRef.current.value = '';
    inputRef.current?.focus();
  }

  const busy = step.kind === 'checking' || step.kind === 'importing';

  return (
    <div className="page page--import">
      <PageHeading>Import from Excel</PageHeading>
      <p className="page__lead">
        Bring in the inventory spreadsheet. We'll check it first and show you what will change — nothing is saved until
        you press <strong>Confirm import</strong>. Items with the same code are updated, new codes are added.
      </p>

      <Steps current={step.kind === 'done' ? 2 : step.kind === 'preview' || step.kind === 'importing' ? 1 : 0} />

      {step.kind !== 'done' && (
        <section className="card" aria-labelledby="choose-heading">
          <h2 id="choose-heading" className="card__title">
            1. Choose your file
          </h2>
          <div className="field">
            <label htmlFor={inputId}>Excel or CSV file</label>
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              accept={ACCEPT}
              onChange={onFileChange}
              disabled={busy}
              aria-describedby={hintId}
              className="file-input"
            />
            {step.kind !== 'choose' && 'file' in step && (
              <p className="file-chosen" data-testid="chosen-file">
                {step.kind === 'checking' ? 'Checking' : 'Selected'}: <strong>{step.file.name}</strong>
              </p>
            )}
            <p id={hintId} className="field__hint">
              .xlsx or .csv, up to 5 MB. The first row should be column headings such as Code, Name, Location, Category,
              Qty, Unit, Condition, Notes (Malay headings like Kod, Nama, Lokasi also work).
            </p>
          </div>
          {step.kind === 'choose' && step.problem && (
            <p className="field__error" role="alert">
              <span aria-hidden="true">⚠ </span>
              {step.problem}
            </p>
          )}
          <p>
            <a href={api.templateUrl} download="item-template.xlsx" className="text-link">
              <span aria-hidden="true">⬇ </span>Download the template (item-template.xlsx)
            </a>
          </p>
        </section>
      )}

      {step.kind === 'checking' && <Loading label={`Checking ${step.file.name}…`} />}

      {step.kind === 'error' && (
        <ImportErrorBox
          step={step}
          onRetry={() => {
            if (step.during === 'import' && step.result) void runImport(step.file, step.result);
            else void runCheck(step.file);
          }}
          onReset={reset}
        />
      )}

      {(step.kind === 'preview' || step.kind === 'importing') && (
        <section className="card" aria-labelledby="preview-heading">
          <h2 id="preview-heading" className="card__title">
            2. Check the preview
          </h2>
          <p className="muted">
            File: <strong>{step.file.name}</strong> ({formatSize(step.file.size)})
          </p>
          <Counts result={step.result} future />
          <p className="field__hint">
            Items are matched by code. Blank cells keep the existing value — to clear a field, edit the item instead.
          </p>
          <IgnoredColumns result={step.result} />
          <ProblemsTables result={step.result} future />
          <PreviewTable rows={step.result.preview} />
          <div className="btn-row">
            <button
              type="button"
              className="btn btn--primary btn--lg"
              onClick={() => void runImport(step.file, step.result)}
              disabled={busy || step.result.created + step.result.updated === 0}
            >
              {step.kind === 'importing' ? 'Importing…' : 'Confirm import'}
            </button>
            <button type="button" className="btn btn--secondary btn--lg" onClick={reset} disabled={busy}>
              Choose a different file
            </button>
          </div>
          {step.result.created + step.result.updated === 0 && (
            <p className="field__warn">
              <span aria-hidden="true">⚠ </span>There is nothing to import in this file.{' '}
              {(step.result.unchanged ?? 0) > 0
                ? 'Every item in it already matches the store-room list.'
                : 'Check the column headings match the template.'}
            </p>
          )}
        </section>
      )}

      {step.kind === 'done' && (
        <section className="card card--success" aria-labelledby="done-heading">
          <div role="status">
            <h2 id="done-heading" className="card__title">
              <span aria-hidden="true">✅ </span>Import finished
            </h2>
          </div>
          <Counts result={step.result} />
          <ProblemsTables result={step.result} />
          <div className="btn-row">
            <Link to="/" className="btn btn--primary">
              Search items
            </Link>
            <Link to="/map" className="btn btn--secondary">
              View the map
            </Link>
            <button type="button" className="btn btn--secondary" onClick={reset}>
              Import another file
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

const STEP_LABELS = ['Choose file', 'Check preview', 'Done'];

function Steps({ current }: { current: number }) {
  return (
    <ol className="steps" aria-label="Import steps">
      {STEP_LABELS.map((label, i) => (
        <li
          key={label}
          className={i === current ? 'is-current' : i < current ? 'is-done' : undefined}
          aria-current={i === current ? 'step' : undefined}
        >
          <span className="steps__num" aria-hidden="true">
            {i < current ? '✓' : i + 1}
          </span>
          {label}
          {i < current && <span className="visually-hidden"> (done)</span>}
        </li>
      ))}
    </ol>
  );
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** A dropped connection during the real import may still have committed on the server. */
export const IMPORT_UNCONFIRMED =
  "We couldn't confirm whether the import finished — search for one of the items to check before importing again";

function errorTitle(step: Extract<Step, { kind: 'error' }>): string {
  if (step.during === 'check') return "Couldn't check that file";
  const connectionLost =
    !(step.error instanceof FileReadError) && step.error instanceof ApiError && step.error.status === 0;
  // Any answer from the server (4xx/5xx/429) means the single-transaction import was rolled back.
  return connectionLost ? IMPORT_UNCONFIRMED : 'The import did not finish — nothing was saved';
}

function ImportErrorBox({
  step,
  onRetry,
  onReset,
}: {
  step: Extract<Step, { kind: 'error' }>;
  onRetry: () => void;
  onReset: () => void;
}) {
  const { message, hints } = describeImportError(step.error);
  // Retrying can't help when the file itself is the problem: offer "choose a different file" instead.
  const fixable =
    step.error instanceof FileReadError ||
    (step.error instanceof ApiError && (step.error.status === 400 || step.error.status === 413));
  return (
    <div className="status status--error" role="alert">
      <p className="status__title">
        {errorTitle(step)}
      </p>
      <p>{message}</p>
      {hints.map((h) => (
        <p key={h}>{h}</p>
      ))}
      <div className="btn-row">
        {!fixable && (
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            Try again
          </button>
        )}
        <button type="button" className="btn btn--secondary" onClick={onReset}>
          Choose a different file
        </button>
        {fixable && (
          <a href={api.templateUrl} download="item-template.xlsx" className="btn btn--secondary">
            Download the template
          </a>
        )}
      </div>
    </div>
  );
}

function Counts({ result, future = false }: { result: ImportResult; future?: boolean }) {
  const { problems, warnings } = splitProblems(result);
  const stats = [
    { label: future ? 'Will be added' : 'Added', value: result.created, cls: 'stat--created' },
    { label: future ? 'Will be updated' : 'Updated', value: result.updated, cls: 'stat--updated' },
    ...(result.unchanged !== undefined
      ? [{ label: future ? 'Already up to date' : 'Unchanged', value: result.unchanged, cls: 'stat--unchanged' }]
      : []),
    { label: future ? 'Will be skipped' : 'Skipped', value: result.skipped, cls: 'stat--skipped' },
    { label: 'Problems', value: problems.length, cls: 'stat--errors' },
    { label: 'Warnings', value: warnings.length, cls: 'stat--warnings' },
  ];
  return (
    <dl className="stats" data-testid="import-counts">
      {stats.map((s) => (
        <div key={s.label} className={`stat ${s.cls}`}>
          <dt>{s.label}</dt>
          <dd>{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function IgnoredColumns({ result }: { result: ImportResult }) {
  const ignored = result.ignoredColumns ?? [];
  if (ignored.length === 0) return null;
  return (
    <div className="note">
      <span aria-hidden="true">ℹ️ </span>
      These columns will be ignored:
      <ul className="note__list">
        {ignored.map((c, i) => (
          <li key={`${i}-${c}`}>
            <strong>{String(c)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProblemsTables({ result, future = false }: { result: ImportResult; future?: boolean }) {
  const { problems, warnings } = splitProblems(result);
  if (problems.length === 0 && warnings.length === 0) {
    return (
      <p className="ok-line">
        <span aria-hidden="true">✓ </span>No problems found.
      </p>
    );
  }
  return (
    <>
      {problems.length > 0 && (
        <RowMessages
          kind="problem"
          caption={`Problems — ${future ? 'these rows will be skipped' : 'these rows were skipped'} (${problems.length})`}
          rows={problems}
        />
      )}
      {warnings.length > 0 && (
        <RowMessages
          kind="warning"
          caption={`Warnings — ${future ? 'these rows will still be imported' : 'these rows were still imported'} (${warnings.length})`}
          rows={warnings}
        />
      )}
    </>
  );
}

function stripWarning(message: string): string {
  const rest = message.replace(/^\s*warning\s*:?\s*/i, '');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function RowMessages({
  kind,
  caption,
  rows,
}: {
  kind: 'problem' | 'warning';
  caption: string;
  rows: ImportRowError[];
}) {
  return (
    <div className={`table-wrap table-wrap--${kind}`}>
      <table className="table" data-testid={`import-${kind}s`}>
        <caption>
          <span aria-hidden="true">{kind === 'problem' ? '✕ ' : '⚠ '}</span>
          {caption}
        </caption>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">{kind === 'problem' ? "What's wrong" : 'Note'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e, i) => (
            <tr key={`${e.row}-${i}`}>
              <td>{e.row}</td>
              <td>{kind === 'warning' ? stripWarning(e.message) : e.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

const ACTION_LABELS: Record<string, string> = { create: 'Add new', update: 'Update', unchanged: 'No change' };

function actionLabel(action: unknown): string {
  return typeof action === 'string' ? (ACTION_LABELS[action] ?? action) : '—';
}

function PreviewTable({ rows }: { rows: ImportPreviewRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="table-wrap">
      <table className="table table--wide" data-testid="import-preview">
        <caption>
          First {rows.length} row{rows.length === 1 ? '' : 's'} as they will be saved
          <span className="table__scroll-hint"> — swipe sideways to see every column</span>
        </caption>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Action</th>
            <th scope="col">Code</th>
            <th scope="col">Location</th>
            <th scope="col">Name</th>
            <th scope="col">Category</th>
            <th scope="col">Qty</th>
            <th scope="col">Condition</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${String(r.row ?? '')}-${String(r.code)}-${i}`}>
              <td>{cell(r.row)}</td>
              <td>{actionLabel(r.action)}</td>
              <td className="code">{cell(r.code)}</td>
              <td>
                <strong>{cell(r.locationCode)}</strong>
              </td>
              <td>{cell(r.name)}</td>
              <td>{cell(r.category)}</td>
              <td>
                {cell(r.quantity)} {r.unit ? String(r.unit) : ''}
              </td>
              <td>{r.condition ? conditionLabel(String(r.condition)) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

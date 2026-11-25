import { useId, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import type { ImportPreviewRow, ImportResult, ImportRowError } from '../api/types';
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
      setStep({ kind: 'error', file, error: toError(err), during: 'check' });
    }
  }

  async function runImport(file: File, preview: ImportResult) {
    setStep({ kind: 'importing', file, result: preview });
    try {
      const result = await api.importFile(file, false);
      setStep({ kind: 'done', result });
    } catch (err) {
      setStep({ kind: 'error', file, error: toError(err), during: 'import', result: preview });
    }
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const problem = checkFile(file);
    if (problem) {
      setStep({ kind: 'choose', problem });
      e.target.value = '';
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
      <h1 className="page__title">Import from Excel</h1>
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
              <span aria-hidden="true">⚠ </span>There is nothing to import in this file. Check the column headings match
              the template.
            </p>
          )}
        </section>
      )}

      {step.kind === 'done' && (
        <section className="card card--success" aria-labelledby="done-heading" role="status">
          <h2 id="done-heading" className="card__title">
            <span aria-hidden="true">✅ </span>Import finished
          </h2>
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
  const fixable = step.error instanceof ApiError && (step.error.status === 400 || step.error.status === 413);
  return (
    <div className="status status--error" role="alert">
      <p className="status__title">
        {step.during === 'check' ? "Couldn't check that file" : 'The import did not finish — nothing was saved'}
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
    <p className="note">
      <span aria-hidden="true">ℹ️ </span>
      These columns were not recognised and will be ignored: <strong>{ignored.join(', ')}</strong>.
    </p>
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

function PreviewTable({ rows }: { rows: ImportPreviewRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="table-wrap">
      <table className="table table--wide" data-testid="import-preview">
        <caption>
          First {rows.length} row{rows.length === 1 ? '' : 's'} as they will be saved
        </caption>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Action</th>
            <th scope="col">Code</th>
            <th scope="col">Name</th>
            <th scope="col">Location</th>
            <th scope="col">Category</th>
            <th scope="col">Qty</th>
            <th scope="col">Condition</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${String(r.row ?? '')}-${String(r.code)}-${i}`}>
              <td>{cell(r.row)}</td>
              <td>{r.action === 'update' ? 'Update' : r.action === 'create' ? 'Add new' : '—'}</td>
              <td className="code">{cell(r.code)}</td>
              <td>{cell(r.name)}</td>
              <td>
                <strong>{cell(r.locationCode)}</strong>
              </td>
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

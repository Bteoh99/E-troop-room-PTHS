import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ScanMatchResponse } from '../api/types';
import { ItemCard } from '../components/ItemCard';
import { PageHeading } from '../components/PageHeading';
import { EmptyState } from '../components/StatusViews';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import * as engine from '../scan/engine';

type Stage = 'idle' | 'preparing' | 'barcode' | 'ocr-loading' | 'ocr' | 'matching' | 'done' | 'error';

const STAGE_TEXT: Partial<Record<Stage, string>> = {
  preparing: 'Getting the photo ready…',
  barcode: 'Looking for a barcode…',
  'ocr-loading': 'Starting the text reader… (the first time can take a while)',
  ocr: 'Reading text…',
  matching: 'Finding matching items…',
};

const MATCHED_ON_LABELS: Record<string, string> = {
  code: 'item code',
  barcode: 'barcode',
  brand: 'brand',
  model: 'model',
  name: 'name',
  category: 'category',
  notes: 'notes',
};

export function matchedOnText(fields: string[]): string {
  return fields.map((f) => MATCHED_ON_LABELS[f] ?? f).join(', ');
}

export default function ScanPage() {
  useDocumentTitle('Scan a label');
  const cameraId = useId();
  const galleryId = useId();
  const textId = useId();
  const cameraRef = useRef<HTMLInputElement>(null);
  const runId = useRef(0);

  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState<number | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [barcode, setBarcode] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [result, setResult] = useState<ScanMatchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchingText, setSearchingText] = useState(false);

  // Free the photo preview when it changes or the page closes.
  useEffect(() => () => void (photoUrl && URL.revokeObjectURL(photoUrl)), [photoUrl]);

  async function process(file: File) {
    const run = ++runId.current;
    const live = () => run === runId.current;
    setPhotoUrl(URL.createObjectURL(file));
    setBarcode(null);
    setText('');
    setResult(null);
    setError(null);
    setProgress(null);
    try {
      setStage('preparing');
      const img = await engine.prepareImage(file);
      if (!live()) return;

      setStage('barcode');
      const code = await engine.findBarcode(img);
      if (!live()) return;
      setBarcode(code);
      if (code) {
        setStage('matching');
        const byBarcode = await api.scanMatch({ barcode: code });
        if (!live()) return;
        if (byBarcode.matches.length > 0) {
          setResult(byBarcode);
          setStage('done');
          return;
        }
      }

      setStage('ocr-loading');
      const recognised = await engine.readText(img.canvas, (s, fraction) => {
        if (!live()) return;
        setStage(s === 'reading' ? 'ocr' : 'ocr-loading');
        setProgress(Math.round(fraction * 100));
      });
      if (!live()) return;
      const cleaned = recognised.replace(/[ \t]+\n/g, '\n').trim();
      setText(cleaned);
      setProgress(null);

      if (!cleaned && !code) {
        setResult({ matches: [], query: { tokens: [] } });
        setStage('done');
        return;
      }
      setStage('matching');
      const res = await api.scanMatch({
        ...(cleaned ? { text: cleaned.slice(0, 2000) } : {}),
        ...(code ? { barcode: code } : {}),
      });
      if (!live()) return;
      setResult(res);
      setStage('done');
    } catch (err) {
      if (!live()) return;
      setError(err instanceof Error ? err.message : 'Something went wrong while reading the photo.');
      setStage('error');
    }
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // so the same photo can be picked again
    if (file) void process(file);
  }

  async function searchWithText() {
    const t = text.trim();
    if (!t) return;
    runId.current++;
    setSearchingText(true);
    setError(null);
    try {
      setResult(await api.scanMatch({ text: t.slice(0, 2000) }));
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
      setStage('error');
    } finally {
      setSearchingText(false);
    }
  }

  const busy = stage in STAGE_TEXT;
  const showText = stage === 'done' || (stage === 'error' && text !== '');

  return (
    <div className="page page--scan">
      <PageHeading>Scan a label</PageHeading>
      <p className="page__lead">
        Take a photo of the item's own label (brand and model) or its shop barcode, and we'll find it in the store room.
      </p>

      <section className="card scan-pick" aria-label="Photo">
        <div className="btn-row scan-pick__buttons">
          <input
            ref={cameraRef}
            id={cameraId}
            type="file"
            accept="image/*"
            capture="environment"
            className="visually-hidden file-trigger"
            onChange={onPick}
            disabled={busy}
          />
          <label htmlFor={cameraId} className={`btn btn--primary btn--lg${busy ? ' is-disabled' : ''}`}>
            <span aria-hidden="true">📷 </span>Take a photo
          </label>
          <input
            id={galleryId}
            type="file"
            accept="image/*"
            className="visually-hidden file-trigger"
            onChange={onPick}
            disabled={busy}
          />
          <label htmlFor={galleryId} className={`btn btn--secondary btn--lg${busy ? ' is-disabled' : ''}`}>
            Choose a photo
          </label>
        </div>
        <ul className="scan-tips" aria-label="Tips for a good scan">
          <li>
            <span aria-hidden="true">💡 </span>Good light — no shadows or glare on the label
          </li>
          <li>
            <span aria-hidden="true">🔍 </span>Fill the frame with the label or barcode
          </li>
          <li>
            <span aria-hidden="true">✋ </span>Hold steady until the photo is taken
          </li>
        </ul>
      </section>

      {photoUrl && (
        <div className="scan-photo">
          <img src={photoUrl} alt="Your photo" className="scan-photo__img" />
          {busy && (
            <div className="scan-progress" role="status" aria-live="polite" data-testid="scan-progress">
              <span className="spinner" aria-hidden="true" />
              <span>{STAGE_TEXT[stage]}</span>
              {progress !== null && stage === 'ocr' && (
                <progress max={100} value={progress} aria-label="Reading progress">
                  {progress}%
                </progress>
              )}
            </div>
          )}
        </div>
      )}

      {stage === 'error' && error && (
        <div className="status status--error" role="alert">
          <p className="status__title">Couldn't finish the scan</p>
          <p>{error}</p>
          <div className="btn-row">
            <button type="button" className="btn btn--secondary" onClick={() => cameraRef.current?.click()}>
              Try another photo
            </button>
            <Link to="/" className="btn btn--secondary">
              Type to search
            </Link>
          </div>
        </div>
      )}

      {barcode && !busy && (
        <p className="scan-barcode" data-testid="scan-barcode">
          <span aria-hidden="true">▌▍▌ </span>Barcode found: <strong className="code">{barcode}</strong>
        </p>
      )}

      {showText && (
        <section className="card" aria-labelledby={`${textId}-h`}>
          <h2 id={`${textId}-h`} className="card__title">
            Text we read
          </h2>
          <div className="field">
            <label htmlFor={textId}>Fix any mistakes, then search again</label>
            <textarea
              id={textId}
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="No text found — type the brand or model here"
              spellCheck={false}
            />
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void searchWithText()}
              disabled={!text.trim() || searchingText}
            >
              {searchingText ? 'Searching…' : 'Search with this text'}
            </button>
          </div>
        </section>
      )}

      {stage === 'done' && result && (
        <section aria-labelledby={`${textId}-results`}>
          {result.matches.length > 0 ? (
            <>
              <h2 id={`${textId}-results`} className="results__count" role="status">
                {result.matches.length === 1 ? 'Found 1 match' : `Found ${result.matches.length} matches`} — best first
              </h2>
              <ul className="results" data-testid="scan-results">
                {result.matches.map((m) => (
                  <li key={m.item.id}>
                    <ItemCard
                      item={m.item}
                      extra={
                        m.matchedOn.length > 0 ? (
                          <p className="matched-on">Matched on: {matchedOnText(m.matchedOn)}</p>
                        ) : null
                      }
                    />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div role="status">
              <h2 id={`${textId}-results`} className="visually-hidden">
                No match
              </h2>
              <EmptyState title="No matching item found" icon="🔎">
                <p>Try a sharper photo of the label, fix the text above, or type to search.</p>
                <div className="btn-row">
                  <button type="button" className="btn btn--primary" onClick={() => cameraRef.current?.click()}>
                    Try another photo
                  </button>
                  <Link to="/" className="btn btn--secondary">
                    Type to search
                  </Link>
                </div>
              </EmptyState>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

import { createWorker, OEM, type Worker } from 'tesseract.js';

/**
 * Tesseract runs fully offline: the worker script, the wasm core and the English language data are
 * copied from npm packages into /ocr/ at build time (scripts/copy-ocr-assets.mjs) and served by our
 * own server — never fetched from a CDN.
 *
 * Robustness (old phones, flaky Wi-Fi):
 * - starting the reader and each read have a time limit; a failed or timed-out start is never cached,
 *   so the next scan tries again;
 * - a running read can be cancelled (leaving the page) — the worker is terminated;
 * - the worker (tens of MB) is terminated after a couple of idle minutes.
 */
export function ocrAssetBase(): string {
  const base = import.meta.env.BASE_URL || '/';
  return new URL(`${base.replace(/\/?$/, '/')}ocr/`, window.location.origin).href;
}

export type OcrProgress = (stage: 'loading' | 'reading', fraction: number) => void;

export const OCR_TIMEOUTS = { initMs: 45_000, readMs: 60_000, idleMs: 120_000 };

export const READER_UNAVAILABLE = "The text reader couldn't load — check you're on the store-room Wi-Fi and try again.";

export type OcrFailure = 'worker' | 'core' | 'language' | 'start' | 'read' | 'read-timeout' | 'cancelled';

export class OcrError extends Error {
  readonly part: OcrFailure;
  constructor(part: OcrFailure, message: string) {
    super(message);
    this.name = 'OcrError';
    this.part = part;
  }
}

const PART_DETAIL: Record<'worker' | 'core' | 'language' | 'start', string> = {
  worker: 'The reader program (ocr/worker.min.js) did not load.',
  core: 'The reader engine (ocr/tesseract-core…wasm.js) did not load.',
  language: 'The English language file (ocr/eng.traineddata.gz) did not load.',
  start: 'The reader did not start in time.',
};

function loadError(part: keyof typeof PART_DETAIL, cause?: unknown): OcrError {
  if (cause !== undefined) console.warn('[scan] text reader failed to load:', cause); // detail for the maintainer
  return new OcrError(part, `${READER_UNAVAILABLE} ${PART_DETAIL[part]}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

interface Job {
  id: number;
  onProgress?: OcrProgress;
}

let workerPromise: Promise<Worker> | null = null;
/** Everything created for the current worker, so it can be terminated even if start-up hangs. */
let created: Promise<Worker> | null = null;
let lastStatus = '';
let activeJob: Job | null = null;
let jobCounter = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Throws the worker away (frees its memory); the next read starts a fresh one. */
export function resetReader(): void {
  const old = created;
  workerPromise = null;
  created = null;
  activeJob = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  old?.then((w) => w.terminate()).catch(() => {});
}

function classify(): keyof typeof PART_DETAIL {
  if (lastStatus === '') return 'worker';
  if (lastStatus.includes('core')) return 'core';
  if (lastStatus.includes('language') || lastStatus.includes('traineddata')) return 'language';
  return 'start';
}

function getWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise;
  const base = ocrAssetBase();
  lastStatus = '';
  let failStart: (reason: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => (failStart = reject));
  failed.catch(() => {}); // handled through the race below
  const attempt = createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: `${base}worker.min.js`,
    corePath: base, // the worker picks tesseract-core(-simd)-lstm.wasm.js from here
    langPath: base, // eng.traineddata.gz
    gzip: true,
    workerBlobURL: false,
    // Without this tesseract.js throws worker errors globally and a failed language download hangs forever.
    errorHandler: (data: unknown) => failStart(data),
    logger: (m: { status: string; progress: number }) => {
      lastStatus = m.status ?? lastStatus;
      const stage = m.status?.startsWith('recognizing') ? 'reading' : 'loading';
      activeJob?.onProgress?.(stage, m.progress ?? 0);
    },
  });
  attempt.catch(() => {});
  created = attempt;
  const mine = withTimeout(Promise.race([attempt, failed]), OCR_TIMEOUTS.initMs, () =>
    loadError(classify() === 'worker' ? 'worker' : classify()),
  ).catch((err: unknown) => {
    const e = err instanceof OcrError ? err : loadError(classify(), err);
    if (workerPromise === mine) resetReader(); // never cache a failed start
    throw e;
  });
  workerPromise = mine;
  return mine;
}

function scheduleIdleTermination(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!activeJob) resetReader();
  }, OCR_TIMEOUTS.idleMs);
}

/**
 * Reads the text on a (prepared) photo. Pass an AbortSignal to cancel (e.g. the user left the page):
 * the worker is terminated and the promise rejects with OcrError('cancelled').
 */
export async function readText(
  canvas: HTMLCanvasElement,
  onProgress?: OcrProgress,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new OcrError('cancelled', 'Scan cancelled.');
  if (idleTimer) clearTimeout(idleTimer);
  const job: Job = { id: ++jobCounter, onProgress };
  activeJob = job;

  let onAbort: (() => void) | null = null;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      if (activeJob === job) resetReader(); // stop the CPU-heavy work
      reject(new OcrError('cancelled', 'Scan cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  cancelled.catch(() => {});

  try {
    const worker = await Promise.race([getWorker(), cancelled]);
    const result = await Promise.race([
      withTimeout(worker.recognize(canvas), OCR_TIMEOUTS.readMs, () => {
        resetReader(); // a stuck job: start afresh next time
        return new OcrError(
          'read-timeout',
          'Reading the text took too long. Try a closer, sharper photo of the label.',
        );
      }),
      cancelled,
    ]).catch((err: unknown) => {
      if (err instanceof OcrError) throw err;
      console.warn('[scan] text reading failed:', err);
      resetReader();
      throw new OcrError('read', "Couldn't read the text on this photo. Try another photo, or type to search.");
    });
    return result.data.text ?? '';
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (activeJob === job) {
      activeJob = null;
      if (workerPromise) scheduleIdleTermination();
    }
  }
}

import { createWorker, OEM, type Worker } from 'tesseract.js';

/**
 * Tesseract runs fully offline: the worker script, the wasm core and the English language data are
 * copied from npm packages into /ocr/ at build time (scripts/copy-ocr-assets.mjs) and served by our
 * own server — never fetched from a CDN.
 */
export function ocrAssetBase(): string {
  const base = import.meta.env.BASE_URL || '/';
  return new URL(`${base.replace(/\/?$/, '/')}ocr/`, window.location.origin).href;
}

export type OcrProgress = (stage: 'loading' | 'reading', fraction: number) => void;

let workerPromise: Promise<Worker> | null = null;
let progressListener: OcrProgress | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    const base = ocrAssetBase();
    workerPromise = createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: `${base}worker.min.js`,
      corePath: base, // the worker picks tesseract-core(-simd)-lstm.wasm.js from here
      langPath: base, // eng.traineddata.gz
      gzip: true,
      workerBlobURL: false,
      logger: (m: { status: string; progress: number }) => {
        const stage = m.status.startsWith('recognizing') ? 'reading' : 'loading';
        progressListener?.(stage, m.progress ?? 0);
      },
    }).catch((err: unknown) => {
      workerPromise = null; // allow a retry
      throw err;
    });
  }
  return workerPromise;
}

/** Reads the text on a (prepared) photo. The worker is kept for the next scan. */
export async function readText(canvas: HTMLCanvasElement, onProgress?: OcrProgress): Promise<string> {
  progressListener = onProgress ?? null;
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);
    return data.text ?? '';
  } finally {
    progressListener = null;
  }
}

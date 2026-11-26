// Copies the offline OCR assets (Tesseract worker, wasm core, English language data) from
// node_modules into public/ocr/, so Vite serves them in dev and copies them into dist/ocr/ on build.
// The app never fetches these from a CDN. Runs automatically before `npm run dev` / `npm run build`.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(path.join(root, 'package.json'));
const outDir = path.join(root, 'public', 'ocr');

const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));

const files = [
  [path.join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'), 'worker.min.js'],
  // LSTM-only cores (we create the worker with OEM.LSTM_ONLY); the worker picks SIMD when supported.
  [path.join(pkgDir('tesseract.js-core'), 'tesseract-core-lstm.wasm.js'), 'tesseract-core-lstm.wasm.js'],
  [path.join(pkgDir('tesseract.js-core'), 'tesseract-core-simd-lstm.wasm.js'), 'tesseract-core-simd-lstm.wasm.js'],
  [path.join(pkgDir('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'), 'eng.traineddata.gz'],
];

mkdirSync(outDir, { recursive: true });
let total = 0;
for (const [from, name] of files) {
  if (!existsSync(from)) {
    console.error(`[ocr-assets] missing ${from} — run npm install`);
    process.exit(1);
  }
  const to = path.join(outDir, name);
  const size = statSync(from).size;
  total += size;
  if (!existsSync(to) || statSync(to).size !== size) copyFileSync(from, to);
}
console.log(`[ocr-assets] ${files.length} files ready in public/ocr (${(total / 1024 / 1024).toFixed(1)} MB)`);

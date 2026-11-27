import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { openDb } from './db/index.js';
import { HttpError, zodDetails } from './lib/errors.js';
import { createAuth } from './auth/index.js';
import { itemsRouter } from './routes/items.js';
import { categoriesRouter } from './routes/categories.js';
import { racksRouter } from './routes/racks.js';
import { importRouter, MAX_UPLOAD_BYTES } from './routes/import.js';
import { scanRouter } from './routes/scan.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Content-Security-Policy for a self-hosted LAN app (no CDNs). 'wasm-unsafe-eval' lets the bundled
 * OCR / barcode WebAssembly run; blob: workers are how tesseract.js starts its worker.
 * No upgrade-insecure-requests / HSTS: the app is plain HTTP on the troop Wi-Fi.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=(), usb=()');
  next();
}

/**
 * Where the built frontend is, or null to not serve it.
 * - opts.staticDir: a folder (served if it has index.html) or false.
 * - otherwise, only in production (NODE_ENV=production or SERVE_FRONTEND=1): FRONTEND_DIST or ../frontend/dist.
 */
export function resolveStaticDir(staticDir) {
  if (staticDir === false) return null;
  let dir = staticDir;
  if (dir === undefined) {
    const serve = process.env.NODE_ENV === 'production' || process.env.SERVE_FRONTEND === '1';
    if (!serve) return null;
    dir = process.env.FRONTEND_DIST || path.join(BACKEND_ROOT, '..', 'frontend', 'dist');
  }
  dir = path.resolve(BACKEND_ROOT, dir);
  return fs.existsSync(path.join(dir, 'index.html')) ? dir : null;
}

/** Missing files with these extensions are 404s; any other path falls back to the SPA. */
export const ASSET_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.wasm', '.json', '.map', '.woff', '.woff2', '.ttf', '.txt', '.webmanifest', '.traineddata', '.gz', '.html']);

const EXTRA_TYPES = { '.wasm': 'application/wasm', '.mjs': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json' };

function frontend(dir) {
  const router = express.Router();
  router.use(express.static(dir, {
    index: false,
    setHeaders(res, file) {
      const type = EXTRA_TYPES[path.extname(file).toLowerCase()];
      if (type) res.setHeader('Content-Type', type);
      // Vite puts content-hashed files in assets/: cache them for a year. Everything else: revalidate.
      const rel = path.relative(dir, file).split(path.sep);
      res.setHeader('Cache-Control', rel[0] === 'assets' ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
  // SPA fallback: client-side routes (/items/3, /items/1.5, /map, ...) get index.html. Only a missing
  // file with a known asset extension is a real 404 (short plain text).
  const indexFile = path.join(dir, 'index.html');
  router.get('*', (req, res) => {
    if (ASSET_EXTENSIONS.has(path.extname(req.path).toLowerCase())) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexFile);
  });
  return router;
}

/**
 * Build the Express app around a database handle (no listen()).
 * Tests: `createApp(openDb(':memory:'), { configPath })` for an isolated DB, or import the default `app`
 * (which opens DB_PATH / CONFIG_PATH on first use).
 * @param {import('better-sqlite3').Database} [db]
 * @param {{ configPath?: string, staticDir?: string|false, limiter?: object, scan?: { perMinute?: number } }} [opts]
 */
export function createApp(db = openDb(), opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.locals.db = db;
  const auth = createAuth({ configPath: opts.configPath, limiter: opts.limiter });
  app.locals.auth = auth;
  app.use(securityHeaders);
  app.use(express.json({ limit: '100kb' }));

  const writesNeedLeader = (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : auth.requireLeader(req, res, next));

  const api = express.Router();
  api.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.get('/health', (req, res) => res.json({ ok: true }));
  api.use('/auth', auth.router);
  api.use('/items', writesNeedLeader, itemsRouter(db));
  api.use('/categories', categoriesRouter(db));
  api.use('/racks', racksRouter(db));
  api.use('/import', writesNeedLeader, importRouter(db)); // template download (GET) stays public
  api.use('/scan', scanRouter(db, opts.scan)); // public, throttled per IP
  api.use((req, res) => {
    res.status(404).json({ error: { message: `No route for ${req.method} ${req.baseUrl}${req.path}` } });
  });
  app.use('/api', api);

  const dist = resolveStaticDir(opts.staticDir);
  app.locals.staticDir = dist;
  if (dist) app.use(frontend(dist));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const { status, body } = toErrorResponse(err);
    if (status >= 500 && !(err instanceof HttpError)) console.error(err); // expected 503s are not crashes
    res.status(status).json(body);
  });

  return app;
}

function toErrorResponse(err) {
  const body = (message, details) => ({ error: details === undefined ? { message } : { message, details } });
  if (err instanceof HttpError) return { status: err.status, body: body(err.message, err.details) };
  if (err instanceof ZodError) return { status: 400, body: body('Validation failed', zodDetails(err)) };
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return { status: 413, body: body(`File too large; the maximum is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`) };
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return { status: 400, body: body(`Unexpected file field "${err.field}"; send one file in the field "file"`) };
    }
    return { status: 400, body: body(`Upload error: ${err.message}`) };
  }
  if (err?.type === 'entity.parse.failed') return { status: 400, body: body('Request body is not valid JSON') };
  if (err?.type === 'entity.too.large') return { status: 413, body: body('Request body too large') };
  if (err?.type === 'charset.unsupported' || err?.type === 'encoding.unsupported') {
    return { status: 400, body: body('Unsupported request body encoding; send JSON as UTF-8') };
  }
  // Any other client error raised by middleware (body-parser, busboy, ...): 400 with a safe message.
  const status = err?.status ?? err?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return { status: status === 413 ? 413 : 400, body: body(err.expose && err.message ? err.message : 'Bad request') };
  }
  if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    // Two writes raced past the checked path; still say which field clashed.
    const field = /barcode/.test(err.message) ? 'barcode' : 'code';
    return { status: 409, body: body(`Duplicate item ${field}`, { field }) };
  }
  return { status: 500, body: body('Internal server error') };
}

/**
 * Default app on DB_PATH, created on first request (importing this module has no side effects).
 * Works anywhere an Express app does: supertest `request(app)`, `http.createServer(app)`.
 */
let defaultApp = null;
export function getDefaultApp() {
  defaultApp ??= createApp(openDb());
  return defaultApp;
}
export const app = (req, res, next) => getDefaultApp()(req, res, next);
export default app;

import express from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { openDb } from './db/index.js';
import { HttpError, zodDetails } from './lib/errors.js';
import { itemsRouter } from './routes/items.js';
import { categoriesRouter } from './routes/categories.js';
import { racksRouter } from './routes/racks.js';
import { importRouter, MAX_UPLOAD_BYTES } from './routes/import.js';

/**
 * Build the Express app around a database handle (no listen()).
 * Tests: `createApp(openDb(':memory:'))` for an isolated DB, or import the default `app`
 * (which opens DB_PATH on first use, e.g. ':memory:' under vitest).
 */
export function createApp(db = openDb()) {
  const app = express();
  app.disable('x-powered-by');
  app.locals.db = db;
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.get('/health', (req, res) => res.json({ ok: true }));
  api.use('/items', itemsRouter(db));
  api.use('/categories', categoriesRouter(db));
  api.use('/racks', racksRouter(db));
  api.use('/import', importRouter(db));
  api.use((req, res) => {
    res.status(404).json({ error: { message: `No route for ${req.method} ${req.baseUrl}${req.path}` } });
  });
  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const { status, body } = toErrorResponse(err);
    if (status >= 500) console.error(err);
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
  if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') return { status: 409, body: body('Duplicate item code') };
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

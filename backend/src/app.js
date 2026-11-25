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
 * (which opens DB_PATH, e.g. ':memory:' under vitest).
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
  if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') return { status: 409, body: body('Duplicate item code') };
  return { status: 500, body: body('Internal server error') };
}

export const app = createApp();
export default app;

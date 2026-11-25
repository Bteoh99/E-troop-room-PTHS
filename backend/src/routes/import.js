import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler, badRequest, HttpError, zodDetails } from '../lib/errors.js';
import { buildTemplate, importItems } from '../services/importer.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXT = new Set(['.xlsx', '.csv']);
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      const hint = ext === '.xls' ? ' Old .xls files are not supported: in Excel use "Save As" > ".xlsx".' : '';
      return cb(badRequest(`Unsupported file type "${ext || 'none'}". Upload an .xlsx or .csv file.${hint}`));
    }
    cb(null, true);
  },
});

/**
 * multer + busboy raise plain Errors for broken multipart bodies ("Unexpected end of form",
 * "Multipart: Boundary not found", ...). Those are client errors: report them as 400.
 */
const single = upload.single('file');
function receiveFile(req, res, next) {
  single(req, res, (err) => {
    if (!err || err instanceof HttpError || err instanceof multer.MulterError) return next(err);
    next(badRequest('The upload was incomplete or malformed. Send the file as multipart/form-data in a field named "file".'));
  });
}

const importQuerySchema = z.object({
  // Defaults to a dry run so a missing flag can never write by accident.
  dryRun: z.enum(['true', 'false', '1', '0']).optional().transform((v) => v !== 'false' && v !== '0'),
});

export function importRouter(db) {
  const router = Router();

  router.get('/template', asyncHandler(async (req, res) => {
    const buf = await buildTemplate();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', 'attachment; filename="item-template.xlsx"');
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  }));

  router.post('/', receiveFile, asyncHandler(async (req, res) => {
    const q = importQuerySchema.safeParse(req.query);
    if (!q.success) throw badRequest('Invalid query parameters: dryRun must be true or false', zodDetails(q.error));
    if (!req.file) throw badRequest('No file uploaded. Send the file in a multipart/form-data field named "file".');
    const ext = path.extname(req.file.originalname).toLowerCase();
    const result = await importItems(db, req.file.buffer, { ext, dryRun: q.data.dryRun });
    res.json(result);
  }));

  return router;
}

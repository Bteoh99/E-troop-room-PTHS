/** Error with an HTTP status; rendered as { error: { message, details? } } by the error handler. */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const conflict = (message, details) => new HttpError(409, message, details);

/** Turn zod issues into a compact, frontend-friendly list. */
export function zodDetails(zodError) {
  return zodError.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Express 4 does not catch rejected promises; wrap async handlers with this. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

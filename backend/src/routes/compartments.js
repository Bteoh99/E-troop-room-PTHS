import { Router } from 'express';
import { deleteCompartment } from '../services/items.js';

/** DELETE /api/compartments/:code — leader only (mounted behind the PIN check): remove an EMPTY compartment. */
export function compartmentsRouter(db) {
  const router = Router();
  router.delete('/:code', (req, res) => {
    deleteCompartment(db, req.params.code);
    res.status(204).end();
  });
  return router;
}

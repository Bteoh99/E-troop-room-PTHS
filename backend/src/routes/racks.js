import { Router } from 'express';
import { normalizeRack } from '../lib/location.js';
import { badRequest, notFound } from '../lib/errors.js';
import { getRack, listRacks } from '../services/items.js';

export function racksRouter(db) {
  const router = Router();

  router.get('/', (req, res) => res.json(listRacks(db)));

  // Accepts "R03", "r3", "3".
  router.get('/:rack', (req, res) => {
    const rack = normalizeRack(req.params.rack);
    if (!rack) throw badRequest(`Invalid rack "${req.params.rack}"; expected something like R03`);
    const data = getRack(db, rack);
    if (!data) throw notFound(`Rack ${rack} has no items`);
    res.json(data);
  });

  return router;
}

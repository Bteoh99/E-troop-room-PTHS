import { Router } from 'express';
import { idParamSchema, listQuerySchema } from '../lib/itemSchema.js';
import { badRequest, notFound, zodDetails } from '../lib/errors.js';
import { createItem, deleteItem, getItem, listItems, updateItem } from '../services/items.js';

function parseId(raw) {
  const r = idParamSchema.safeParse(raw);
  if (!r.success) throw badRequest('Invalid item id', zodDetails(r.error));
  return r.data;
}

export function itemsRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest('Invalid query parameters', zodDetails(parsed.error));
    res.json({ items: listItems(db, parsed.data) });
  });

  router.get('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const item = getItem(db, id);
    if (!item) throw notFound(`Item ${id} not found`);
    res.json(item);
  });

  router.post('/', (req, res) => {
    res.status(201).json(createItem(db, req.body ?? {}));
  });

  router.put('/:id', (req, res) => {
    res.json(updateItem(db, parseId(req.params.id), req.body ?? {}));
  });

  router.delete('/:id', (req, res) => {
    deleteItem(db, parseId(req.params.id));
    res.status(204).end();
  });

  return router;
}

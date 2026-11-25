import { Router } from 'express';
import { listCategories } from '../services/items.js';

export function categoriesRouter(db) {
  const router = Router();
  router.get('/', (req, res) => res.json({ categories: listCategories(db) }));
  return router;
}

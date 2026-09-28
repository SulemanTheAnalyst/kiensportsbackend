import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { listProducts, getProductBySlug, listCategories, listCollections } from './product.service';
import { apiLimiter } from '../../middleware/errorHandler';

export const catalogRouter = Router();

const listQuerySchema = z.object({
  category: z.enum(['sport', 'lifestyle']).optional(),
  subcategory: z.string().max(60).optional(),
  collection: z.string().max(60).optional(),
  featured: z.enum(["true","false"]).transform(v => v === "true").optional(),
  newArrival: z.enum(["true","false"]).transform(v => v === "true").optional(),
  bestSeller: z.enum(["true","false"]).transform(v => v === "true").optional(),
  search: z.string().max(100).optional(),
  sort: z.enum(['newest', 'price-asc', 'price-desc', 'name']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
});

catalogRouter.get('/products', validate({ query: listQuerySchema }), async (req, res) => {
  res.json({ data: await listProducts(req.query as never) });
});

catalogRouter.get(
  '/products/:slug',
  validate({ params: z.object({ slug: z.string().min(1).max(120) }) }),
  async (req, res) => {
    res.json({ data: await getProductBySlug(String(req.params.slug)) });
  },
);

catalogRouter.get(
  '/categories',
  validate({ query: z.object({ world: z.enum(['sport', 'lifestyle']).optional() }) }),
  async (req, res) => {
    res.json({ data: await listCategories((req.query as { world?: string }).world) });
  },
);

catalogRouter.get('/collections', async (_req, res) => {
  res.json({ data: await listCollections() });
});

// Search endpoint backing the header SearchOverlay (min 2 chars, like the UI).
catalogRouter.get(
  '/search',
  apiLimiter(60_000, 60),
  validate({
    query: z.object({ q: z.string().min(2).max(100), limit: z.coerce.number().int().min(1).max(20).optional() }),
  }),
  async (req, res) => {
    const { q, limit } = req.query as unknown as { q: string; limit?: number };
    const result = await listProducts({ search: q, limit: limit ?? 8, page: 1 });
    res.json({ data: result.data });
  },
);

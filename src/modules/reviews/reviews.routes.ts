import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { apiLimiter } from '../../middleware/errorHandler';

// Reviews: only verified purchasers, moderated before display.
// (The frontend has no review UI yet; this API is ready for it.)

export const reviewsRouter = Router();

reviewsRouter.get(
  '/products/:productId/reviews',
  validate({ params: z.object({ productId: z.string().min(10).max(40) }) }),
  async (req, res) => {
    const reviews = await prisma.review.findMany({
      where: { productId: String(req.params.productId), moderationStatus: 'APPROVED' },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { firstName: true } } },
    });
    const avg = reviews.length
      ? Math.round((reviews.reduce((a, r) => a + r.rating, 0) / reviews.length) * 10) / 10
      : null;
    res.json({
      data: {
        averageRating: avg,
        count: reviews.length,
        reviews: reviews.map((r) => ({
          id: r.id,
          rating: r.rating,
          title: r.title,
          body: r.body,
          isVerifiedPurchase: r.isVerifiedPurchase,
          author: r.user.firstName,
          createdAt: r.createdAt,
        })),
      },
    });
  },
);

reviewsRouter.post(
  '/products/:productId/reviews',
  apiLimiter(60 * 60_000, 10),
  requireAuth,
  validate({
    params: z.object({ productId: z.string().min(10).max(40) }),
    body: z.object({
      rating: z.coerce.number().int().min(1).max(5),
      title: z.string().max(120).optional(),
      body: z.string().min(10).max(2000),
    }),
  }),
  async (req, res) => {
    const product = await prisma.product.findFirst({ where: { id: String(req.params.productId), status: 'ACTIVE' } });
    if (!product) throw notFound('Product not found');
    const existing = await prisma.review.findUnique({
      where: { productId_userId: { productId: product.id, userId: req.user!.sub } },
    });
    if (existing) throw badRequest('You have already reviewed this product');
    // Verified purchase = user has a PAID order containing this product.
    const purchased = await prisma.orderItem.findFirst({
      where: {
        variant: { productId: product.id },
        order: { userId: req.user!.sub, paymentStatus: 'PAID' },
      },
    });
    const review = await prisma.review.create({
      data: {
        productId: product.id,
        userId: req.user!.sub,
        rating: req.body.rating,
        title: req.body.title,
        body: req.body.body,
        isVerifiedPurchase: !!purchased,
        moderationStatus: 'PENDING',
      },
    });
    res.status(201).json({ data: { id: review.id, moderationStatus: review.moderationStatus } });
  },
);

export const adminReviewsRouter = Router();
adminReviewsRouter.use(requireAuth, requireRole('ADMIN'));
adminReviewsRouter.get('/reviews', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'PENDING';
  const reviews = await prisma.review.findMany({
    where: { moderationStatus: status },
    include: { product: { select: { name: true, slug: true } }, user: { select: { email: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ data: reviews });
});
adminReviewsRouter.patch(
  '/reviews/:id/moderate',
  validate({
    params: z.object({ id: z.string().min(10).max(40) }),
    body: z.object({ status: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(500).optional() }),
  }),
  async (req, res) => {
    const review = await prisma.review.findUnique({ where: { id: String(req.params.id) } });
    if (!review) throw notFound('Review not found');
    const updated = await prisma.review.update({
      where: { id: review.id },
      data: {
        moderationStatus: req.body.status,
        publishedAt: req.body.status === 'APPROVED' ? new Date() : null,
      },
    });
    res.json({ data: { id: updated.id, moderationStatus: updated.moderationStatus } });
  },
);

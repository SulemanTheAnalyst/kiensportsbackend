import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { apiLimiter, errorHandler, notFoundHandler } from './middleware/errorHandler';
import { catalogRouter } from './modules/catalog/catalog.routes';
import { authRouter } from './modules/auth/auth.routes';
import { accountRouter } from './modules/account/account.routes';
import { cartRouter } from './modules/cart/cart.routes';
import { orderRouter, paymentWebhookRouter } from './modules/payment/payment.routes';
import { shippingRouter, adminShippingRouter } from './modules/shipping/shipping.routes';
import { returnsRouter, adminReturnsRouter } from './modules/returns/returns.routes';
import { reviewsRouter, adminReviewsRouter } from './modules/reviews/reviews.routes';
import { newsletterRouter, adminNewsletterRouter } from './modules/newsletter/newsletter.routes';
import { contactRouter, adminContactRouter } from './modules/contact/contact.routes';
import { adminRouter } from './modules/admin/admin.routes';

export const createApp = (): Express => {
  const app = express();

  app.set('trust proxy', 1); // behind a reverse proxy in production

  // Security headers
  app.use(helmet());

  // CORS: strict allow-list of the KIEN frontend origins.
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      maxAge: 600,
    }),
  );

  // All JSON bodies are captured raw first: payment webhook signature
  // verification needs the exact bytes.
  app.use(
    express.json({
      limit: '100kb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(cookieParser());

  const api = express.Router();
  api.use(apiLimiter(60_000, 300)); // global baseline

  api.get('/health', (_req, res) => res.json({ data: { status: 'ok' } }));

  // Public + customer
  api.use('/auth', authRouter);
  api.use('/account', accountRouter);
  api.use('/cart', cartRouter);
  api.use(catalogRouter); // /products, /categories, /collections, /search
  api.use(reviewsRouter); // /products/:productId/reviews
  api.use('/orders', orderRouter);
  api.use('/shipping', shippingRouter);
  api.use('/returns', returnsRouter);
  api.use('/newsletter', newsletterRouter);
  api.use('/contact', contactRouter);

  // Payments (webhook mounts under /payments too)
  api.use('/payments', paymentWebhookRouter);

  // Admin - all routes below require ADMIN role
  api.use('/admin', adminRouter, adminShippingRouter, adminReturnsRouter, adminReviewsRouter, adminNewsletterRouter, adminContactRouter);

  app.use(env.API_BASE_PATH, api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};

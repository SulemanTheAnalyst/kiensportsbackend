import express, { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { badRequest } from '../../lib/errors';
import { MAX_IMAGE_BYTES, detectImageType, imageStorageConfigured, uploadImage } from './image.storage';

/**
 * Admin product-image upload endpoint.
 *
 * POST /admin/images?filename=foo.jpg
 *   - raw binary body (application/octet-stream), NOT multipart
 *   - ADMIN role required (enforced below)
 *   - server-side validation: non-empty, <= 5 MB, magic-byte JPEG/PNG/WebP
 *   - 503 STORAGE_NOT_CONFIGURED until CLOUDINARY_* env vars are set
 *   - returns { data: { url } } with the hosted HTTPS url on 201
 */
export const adminImagesRouter = Router();
adminImagesRouter.use(requireAuth, requireRole('ADMIN'));

adminImagesRouter.post(
  '/images',
  express.raw({ type: 'application/octet-stream', limit: 6 * 1024 * 1024 }),
  async (req, res) => {
    const buf = req.body as unknown as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw badRequest('Empty upload: send the image bytes as the request body (Content-Type: application/octet-stream)');
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      throw badRequest('Image is larger than the 5 MB limit');
    }
    if (!detectImageType(buf)) {
      throw badRequest('Unsupported image type: only JPEG, PNG and WebP are accepted');
    }
    if (!imageStorageConfigured()) {
      return res.status(503).json({
        error: {
          code: 'STORAGE_NOT_CONFIGURED',
          message:
            'Image storage is not configured on the server. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET, then redeploy.',
        },
      });
    }
    const filename = (typeof req.query.filename === 'string' ? req.query.filename : 'upload').slice(0, 200);
    let stored;
    try {
      stored = await uploadImage(buf, filename);
    } catch (err) {
      console.error('image upload failed:', err instanceof Error ? err.message : err);
      return res.status(502).json({
        error: { code: 'STORAGE_ERROR', message: 'Uploading the image failed. Please try again.' },
      });
    }
    res.status(201).json({ data: { url: stored.url } });
  },
);

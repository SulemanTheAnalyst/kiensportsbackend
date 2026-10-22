import express, { Router, Response } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { badRequest } from '../../lib/errors';
import {
  detectImageType,
  detectMediaType,
  imageStorageConfigured,
  maxImageBytes,
  maxVideoBytes,
  missingCloudinaryVars,
  uploadMedia,
  type MediaType,
} from './image.storage';

/**
 * Admin product-media upload endpoints. ADMIN role required; raw binary
 * bodies (application/octet-stream), NOT multipart. The real file type is
 * detected from magic bytes on the server - the filename and the client
 * Content-Type are never trusted.
 *
 * POST /admin/images?filename=foo.jpg   (legacy, images only)
 *   - <= 5 MB, magic-byte JPEG/PNG/WebP
 *   - 201 { data: { url } }
 *
 * POST /admin/media?filename=clip.mp4   (images AND videos)
 *   - images: JPEG/PNG/WebP, <= 5 MB
 *   - videos: MP4/WebM, <= 100 MB (Cloudinary free-plan cap)
 *   - 201 { data: { url, mediaType, publicId, resourceType, format } }
 *
 * Both return 503 STORAGE_NOT_CONFIGURED when the required Cloudinary env
 * vars are missing or empty; the error names exactly which variables are
 * missing (names only, never values).
 */
export const adminImagesRouter = Router();
adminImagesRouter.use(requireAuth, requireRole('ADMIN'));

const storageNotConfigured = (res: Response) => {
  const missing = missingCloudinaryVars();
  return res.status(503).json({
    error: {
      code: 'STORAGE_NOT_CONFIGURED',
      message:
        'Media storage is not configured on the server. Missing or empty environment variables: ' +
        (missing.length > 0 ? missing.join(', ') : 'unknown') +
        '. Set them on the backend service (Render → Environment), then redeploy.',
      missingVariables: missing,
    },
  });
};

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

adminImagesRouter.post(
  '/images',
  express.raw({ type: 'application/octet-stream', limit: 6 * 1024 * 1024 }),
  async (req, res) => {
    const buf = req.body as unknown as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw badRequest('Empty upload: send the image bytes as the request body (Content-Type: application/octet-stream)');
    }
    if (buf.length > maxImageBytes()) {
      throw badRequest(`Image is larger than the ${mb(maxImageBytes())} MB limit`);
    }
    if (!detectImageType(buf)) {
      throw badRequest('Unsupported image type: only JPEG, PNG and WebP are accepted');
    }
    if (!imageStorageConfigured()) return storageNotConfigured(res);
    const filename = (typeof req.query.filename === 'string' ? req.query.filename : 'upload').slice(0, 200);
    let stored;
    try {
      stored = await uploadMedia(buf, filename, 'IMAGE');
    } catch (err) {
      console.error('image upload failed:', err instanceof Error ? err.message : err);
      return res.status(502).json({
        error: { code: 'STORAGE_ERROR', message: 'Uploading the image failed. Please try again.' },
      });
    }
    res.status(201).json({ data: { url: stored.url } });
  },
);

adminImagesRouter.post(
  '/media',
  express.raw({ type: 'application/octet-stream', limit: 110 * 1024 * 1024 }),
  async (req, res) => {
    const buf = req.body as unknown as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw badRequest('Empty upload: send the file bytes as the request body (Content-Type: application/octet-stream)');
    }
    const detected = detectMediaType(buf);
    if (!detected) {
      throw badRequest('Unsupported media type: images must be JPEG, PNG or WebP; videos must be MP4 or WebM');
    }
    const mediaType: MediaType = detected.mediaType;
    const max = mediaType === 'VIDEO' ? maxVideoBytes() : maxImageBytes();
    if (buf.length > max) {
      throw badRequest(
        mediaType === 'VIDEO'
          ? `Video is larger than the ${mb(maxVideoBytes())} MB limit`
          : `Image is larger than the ${mb(maxImageBytes())} MB limit`,
      );
    }
    if (!imageStorageConfigured()) return storageNotConfigured(res);
    const filename = (typeof req.query.filename === 'string' ? req.query.filename : 'upload').slice(0, 200);
    let stored;
    try {
      stored = await uploadMedia(buf, filename, mediaType);
    } catch (err) {
      console.error('media upload failed:', err instanceof Error ? err.message : err);
      return res.status(502).json({
        error: { code: 'STORAGE_ERROR', message: 'Uploading the file failed. Please try again.' },
      });
    }
    res.status(201).json({
      data: {
        url: stored.url,
        mediaType,
        publicId: stored.publicId,
        resourceType: stored.resourceType,
        format: stored.format,
      },
    });
  },
);

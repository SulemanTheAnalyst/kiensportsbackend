import express, { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { badRequest } from '../../lib/errors';
import {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  detectImageType,
  detectVideoType,
  mediaStorageConfigured,
  missingStorageEnvVars,
  uploadImage,
  uploadVideo,
} from './media.storage';

/**
 * Admin product media upload endpoints (images AND videos).
 *
 * POST /admin/images?filename=foo.jpg  - raw binary body, JPEG/PNG/WebP, <= 5 MB
 * POST /admin/videos?filename=foo.mp4  - raw binary body, MP4/WebM/MOV, <= 100 MB
 *
 * - ADMIN role required (enforced below).
 * - Raw binary body (application/octet-stream), NOT multipart - no new deps.
 * - Validation by magic bytes, never filename or browser Content-Type.
 * - File-type-specific size limits (the 5 MB image limit is NOT applied to
 *   videos; Cloudinary's free plan caps video files at 100 MB).
 * - 503 STORAGE_NOT_CONFIGURED until the CLOUDINARY_* env vars are present
 *   in the running process. On that path the exact missing variable NAMES
 *   are logged server-side (values are never logged).
 * - Failed Cloudinary calls surface as 502 STORAGE_ERROR - never as success.
 */
export const adminMediaRouter = Router();
adminMediaRouter.use(requireAuth, requireRole('ADMIN'));

const storageNotConfiguredResponse = () => {
  // Log the missing variable NAMES so Render logs pinpoint dashboard issues.
  const missing = missingStorageEnvVars();
  console.error(
    'Cloudinary media storage is not configured.' +
      (missing.length ? ' Missing env vars: ' + missing.join(', ') + '.' : ''),
  );
  return {
    error: {
      code: 'STORAGE_NOT_CONFIGURED',
      message:
        'Image/video storage is not configured on the server. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET on the backend service and restart/redeploy it (Render does not inject dashboard env changes into a running process).',
    },
  };
};

adminMediaRouter.post(
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
    if (!mediaStorageConfigured()) {
      return res.status(503).json(storageNotConfiguredResponse());
    }
    const filename = (typeof req.query.filename === 'string' ? req.query.filename : 'upload.jpg').slice(0, 200);
    let stored;
    try {
      stored = await uploadImage(buf, filename);
    } catch (err) {
      console.error('image upload failed:', err instanceof Error ? err.message : err);
      return res.status(502).json({
        error: { code: 'STORAGE_ERROR', message: 'Uploading the image failed. Please try again.' },
      });
    }
    res.status(201).json({
      data: {
        url: stored.url,
        publicId: stored.publicId,
        format: stored.format,
        width: stored.width,
        height: stored.height,
        mediaType: 'IMAGE' as const,
      },
    });
  },
);

adminMediaRouter.post(
  '/videos',
  express.raw({ type: 'application/octet-stream', limit: 101 * 1024 * 1024 }),
  async (req, res) => {
    const buf = req.body as unknown as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw badRequest('Empty upload: send the video bytes as the request body (Content-Type: application/octet-stream)');
    }
    if (buf.length > MAX_VIDEO_BYTES) {
      throw badRequest('Video is larger than the 100 MB limit');
    }
    if (!detectVideoType(buf)) {
      throw badRequest('Unsupported video type: only MP4, WebM and MOV are accepted');
    }
    if (!mediaStorageConfigured()) {
      return res.status(503).json(storageNotConfiguredResponse());
    }
    const filename = (typeof req.query.filename === 'string' ? req.query.filename : 'upload.mp4').slice(0, 200);
    let stored;
    try {
      stored = await uploadVideo(buf, filename);
    } catch (err) {
      console.error('video upload failed:', err instanceof Error ? err.message : err);
      return res.status(502).json({
        error: { code: 'STORAGE_ERROR', message: 'Uploading the video failed. Please try again.' },
      });
    }
    res.status(201).json({
      data: {
        url: stored.url,
        publicId: stored.publicId,
        format: stored.format,
        width: stored.width,
        height: stored.height,
        durationSeconds: stored.durationSeconds,
        mediaType: 'VIDEO' as const,
      },
    });
  },
);

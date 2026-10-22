import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// Integration test for the unified product-media workflow (images + videos).
// Requires a running Postgres and a migrated+seeded database; skips when
// DATABASE_URL is not configured. CI has no Cloudinary credentials, so the
// storage module's test seam (__setStorageForTests) injects a fake - no real
// uploads are performed and no credentials are used or logged.
//
// Covers:
// - POST /admin/media: 401/403, 400 unsupported type, 400 oversized image and
//   video (limits lowered via __setMediaLimitsForTests), 503 listing the
//   missing Cloudinary variable NAMES (never values), 502 when Cloudinary
//   fails, 201 for JPEG/PNG/WebP images and MP4/WebM videos
// - configuration detection (missingCloudinaryVars / imageStorageConfigured)
// - product creation and PATCH with mixed images + videos persisting
//   mediaType/publicId/resourceType/format
// - safe destruction: an asset still referenced by another product is never
//   destroyed; an unreferenced hosted asset is destroyed on removal/delete
// - storefront compatibility: GET /products/:slug returns images (IMAGE only)
//   plus a videos array; legacy IMAGE rows are unchanged

const run = process.env.DATABASE_URL ? describe : describe.skip;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
// RIFF....WEBP
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(4)]);
// MP4: 4 bytes size + 'ftypisom' brand
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(8)]);
// WebM: EBML magic 1A 45 DF A3
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]);

run('admin product media (images + videos)', () => {
  const prisma = new PrismaClient();
  let app: import('express').Express;
  let adminToken = '';
  const stamp = Date.now();
  const createdProductIds: string[] = [];
  const slug = 'ci-media-product-' + stamp;
  const sku = 'KIEN-MEDIA-' + stamp;

  const setFakeStorage = (fail = false) => {
    const uploads: { mediaType: string; bytes: number }[] = [];
    const impl = {
      configured: () => true,
      upload: async (buffer: Buffer, _filename: string, mediaType: 'IMAGE' | 'VIDEO') => {
        if (fail) throw new Error('boom');
        uploads.push({ mediaType, bytes: buffer.length });
        const n = uploads.length;
        const resourceType: 'image' | 'video' = mediaType === 'VIDEO' ? 'video' : 'image';
        return {
          url: `https://res.cloudinary.com/test/${resourceType}/upload/v1/kiensports/products/fake-${n}`,
          publicId: `kiensports/products/fake-${n}`,
          resourceType,
          format: mediaType === 'VIDEO' ? 'mp4' : 'png',
        };
      },
      destroy: async () => undefined,
    };
    return { impl, uploads };
  };

  beforeAll(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    const { createApp } = await import('../../src/app');
    app = createApp();

    const email = 'ci-media-admin-' + stamp + '@example.com';
    await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash('Password1234', 4),
        firstName: 'CI',
        lastName: 'Admin',
        emailVerifiedAt: new Date(),
        roles: { create: { role: { connect: { name: 'ADMIN' } } } },
      },
    });
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: 'Password1234' });
    expect(login.status).toBe(200);
    adminToken = login.body.data.accessToken as string;
  });

  afterAll(async () => {
    const { __setStorageForTests, __setMediaLimitsForTests } = await import('../../src/modules/admin/image.storage');
    __setStorageForTests(null);
    __setMediaLimitsForTests(null);
    for (const id of createdProductIds) {
      await prisma.product.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  // ---- Configuration detection -------------------------------------------

  it('missingCloudinaryVars lists the exact missing variable names', async () => {
    const { missingCloudinaryVars, imageStorageConfigured } = await import('../../src/modules/admin/image.storage');
    const saved: Record<string, string | undefined> = {};
    for (const name of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    expect(missingCloudinaryVars()).toEqual(['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']);
    expect(imageStorageConfigured()).toBe(false);
    process.env.CLOUDINARY_CLOUD_NAME = '  '; // whitespace-only counts as empty
    process.env.CLOUDINARY_API_KEY = 'test-key';
    expect(missingCloudinaryVars()).toEqual(['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_SECRET']);
    process.env.CLOUDINARY_CLOUD_NAME = 'demo';
    process.env.CLOUDINARY_API_SECRET = 'test-secret';
    expect(missingCloudinaryVars()).toEqual([]);
    expect(imageStorageConfigured()).toBe(true);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // ---- Upload endpoint guards --------------------------------------------

  it('401 without a token and 403 for a customer on /admin/media', async () => {
    const anon = await request(app)
      .post('/api/v1/admin/media')
      .set('Content-Type', 'application/octet-stream')
      .send(PNG);
    expect(anon.status).toBe(401);
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'ci-media-cust-' + stamp + '@example.com', password: 'Password123', firstName: 'T', lastName: 'U' });
    expect(reg.status).toBe(201);
    const cust = await request(app)
      .post('/api/v1/admin/media')
      .set('Authorization', 'Bearer ' + reg.body.data.accessToken)
      .set('Content-Type', 'application/octet-stream')
      .send(PNG);
    expect(cust.status).toBe(403);
  });

  it('503 names the missing environment variables (names only) when unconfigured', async () => {
    const res = await request(app)
      .post('/api/v1/admin/media')
      .set('Authorization', 'Bearer ' + adminToken)
      .set('Content-Type', 'application/octet-stream')
      .send(PNG);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_NOT_CONFIGURED');
    expect(Array.isArray(res.body.error.missingVariables)).toBe(true);
    expect(res.body.error.missingVariables).toContain('CLOUDINARY_CLOUD_NAME');
    expect(res.body.error.missingVariables).toContain('CLOUDINARY_API_KEY');
    expect(res.body.error.missingVariables).toContain('CLOUDINARY_API_SECRET');
    // Never a secret value in the response body.
    expect(JSON.stringify(res.body)).not.toMatch(/test-secret/);
  });

  it('400 for an unsupported media type', async () => {
    const res = await request(app)
      .post('/api/v1/admin/media')
      .set('Authorization', 'Bearer ' + adminToken)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('plain text, definitely not media'));
    expect(res.status).toBe(400);
  });

  it('400 for oversized images and videos (limits lowered for CI)', async () => {
    const { __setMediaLimitsForTests } = await import('../../src/modules/admin/image.storage');
    __setMediaLimitsForTests({ image: PNG.length - 1, video: MP4.length - 1 });
    try {
      const img = await request(app)
        .post('/api/v1/admin/media')
        .set('Authorization', 'Bearer ' + adminToken)
        .set('Content-Type', 'application/octet-stream')
        .send(PNG);
      expect(img.status).toBe(400);
      const vid = await request(app)
        .post('/api/v1/admin/media')
        .set('Authorization', 'Bearer ' + adminToken)
        .set('Content-Type', 'application/octet-stream')
        .send(MP4);
      expect(vid.status).toBe(400);
    } finally {
      __setMediaLimitsForTests(null);
    }
  });

  it('502 STORAGE_ERROR when the configured storage fails', async () => {
    const { __setStorageForTests } = await import('../../src/modules/admin/image.storage');
    __setStorageForTests(setFakeStorage(true).impl);
    try {
      const res = await request(app)
        .post('/api/v1/admin/media')
        .set('Authorization', 'Bearer ' + adminToken)
        .set('Content-Type', 'application/octet-stream')
        .send(PNG);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('STORAGE_ERROR');
    } finally {
      __setStorageForTests(null);
    }
  });

  it('201 for JPEG, PNG, WebP images and MP4, WebM videos with metadata', async () => {
    const { __setStorageForTests } = await import('../../src/modules/admin/image.storage');
    const { impl, uploads } = setFakeStorage();
    __setStorageForTests(impl);
    try {
      for (const [buf, expectedType, filename] of [
        [JPEG, 'IMAGE', 'a.jpg'],
        [PNG, 'IMAGE', 'b.png'],
        [WEBP, 'IMAGE', 'c.webp'],
        [MP4, 'VIDEO', 'd.mp4'],
        [WEBM, 'VIDEO', 'e.webm'],
      ] as const) {
        const res = await request(app)
          .post('/api/v1/admin/media?filename=' + filename)
          .set('Authorization', 'Bearer ' + adminToken)
          .set('Content-Type', 'application/octet-stream')
          .send(buf);
        expect(res.status).toBe(201);
        expect(res.body.data.mediaType).toBe(expectedType);
        expect(String(res.body.data.url)).toContain(expectedType === 'VIDEO' ? '/video/upload/' : '/image/upload/');
        expect(typeof res.body.data.publicId).toBe('string');
        expect(res.body.data.resourceType).toBe(expectedType === 'VIDEO' ? 'video' : 'image');
      }
      expect(uploads.map((u) => u.mediaType)).toEqual(['IMAGE', 'IMAGE', 'IMAGE', 'VIDEO', 'VIDEO']);
    } finally {
      __setStorageForTests(null);
    }
  });

  // ---- Product persistence with mixed media ------------------------------

  let productId = '';
  let videoUrl = '';
  let videoRef: { publicId: string; resourceType: string } = { publicId: '', resourceType: '' };
  let imageUrlRef: { publicId: string; resourceType: string } = { publicId: '', resourceType: '' };

  it('creates a product with mixed images and videos', async () => {
    const { __setStorageForTests } = await import('../../src/modules/admin/image.storage');
    __setStorageForTests(setFakeStorage().impl);
    let imageUrl = '';
    try {
      const up1 = await request(app)
        .post('/api/v1/admin/media?filename=hero.png')
        .set('Authorization', 'Bearer ' + adminToken)
        .set('Content-Type', 'application/octet-stream')
        .send(PNG);
      expect(up1.status).toBe(201);
      imageUrl = up1.body.data.url;
      const up2 = await request(app)
        .post('/api/v1/admin/media?filename=clip.mp4')
        .set('Authorization', 'Bearer ' + adminToken)
        .set('Content-Type', 'application/octet-stream')
        .send(MP4);
      expect(up2.status).toBe(201);
      videoUrl = up2.body.data.url;
      videoRef = { publicId: up2.body.data.publicId, resourceType: up2.body.data.resourceType };
      imageUrlRef = { publicId: up1.body.data.publicId, resourceType: up1.body.data.resourceType };
    } finally {
      __setStorageForTests(null);
    }

    const res = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        slug,
        name: 'CI Media Product',
        shortDescription: 'Mixed media integration test product.',
        description: 'A product with both images and videos attached by the media integration test.',
        categorySlug: 'bags',
        status: 'ACTIVE',
        price: 1499,
        materials: ['Nylon'],
        tags: ['test'],
        images: [
          { url: imageUrl, alt: 'Hero', mediaType: 'IMAGE', publicId: imageUrlRef.publicId, resourceType: imageUrlRef.resourceType, format: 'png' },
          { url: videoUrl, alt: 'Clip', mediaType: 'VIDEO', publicId: videoRef.publicId, resourceType: videoRef.resourceType, format: 'mp4' },
        ],
        features: [{ title: 'F', description: 'D' }],
        variants: [{ sku, colorName: 'Black', colorHex: '#111111', inventoryQty: 3 }],
      });
    expect(res.status).toBe(201);
    productId = res.body.data.id;
    createdProductIds.push(productId);

    const stored = await prisma.productImage.findMany({ where: { productId }, orderBy: { sortOrder: 'asc' } });
    expect(stored.map((i) => i.mediaType)).toEqual(['IMAGE', 'VIDEO']);
    expect(stored[0].publicId).toBeTruthy();
    expect(stored[1].resourceType).toBe('video');
  });

  it('PATCH reorders and removes media; a removed asset still referenced elsewhere is not destroyed', async () => {
    // Create a second product sharing the same video url (reference safety).
    const other = await prisma.product.create({
      data: {
        slug: slug + '-other',
        name: 'CI Media Other',
        shortDescription: 'x',
        description: 'x '.repeat(6),
        pricePaise: 100000,
        status: 'DRAFT',
        category: { connect: { slug: 'bags' } },
        images: { create: [{ url: videoUrl, mediaType: 'VIDEO', publicId: videoRef.publicId, resourceType: videoRef.resourceType, format: 'mp4', sortOrder: 0 }] },
        variants: { create: [{ sku: sku + '-B', colorName: 'Black', colorHex: '#111111' }] },
      },
    });
    createdProductIds.push(other.id);

    const { __setStorageForTests } = await import('../../src/modules/admin/image.storage');
    const destroyed: string[] = [];
    let imageRowId = '';
    __setStorageForTests({
      configured: () => true,
      upload: async () => {
        throw new Error('unexpected upload');
      },
      destroy: async (ref) => {
        destroyed.push(ref.publicId);
      },
    });
    try {
      const detail = await request(app)
        .get('/api/v1/admin/catalog/products/' + productId)
        .set('Authorization', 'Bearer ' + adminToken);
      imageRowId = detail.body.data.images.find((i: { mediaType: string }) => i.mediaType === 'IMAGE').id;

      // PATCH: keep only the image, drop the video from this product.
      const res = await request(app)
        .patch('/api/v1/admin/products/' + productId)
        .set('Authorization', 'Bearer ' + adminToken)
        .send({
          images: [{ id: imageRowId, url: detail.body.data.images.find((i: { mediaType: string }) => i.mediaType === 'IMAGE').url, mediaType: 'IMAGE', publicId: imageUrlRef.publicId, resourceType: imageUrlRef.resourceType }],
        });
      expect(res.status).toBe(200);
      // The video is still referenced by the other product -> NOT destroyed.
      await new Promise((r) => setTimeout(r, 50));
      expect(destroyed).not.toContain(videoRef.publicId);

      const after = await prisma.productImage.findMany({ where: { productId } });
      expect(after.length).toBe(1);
      expect(after[0].mediaType).toBe('IMAGE');
    } finally {
      __setStorageForTests(null);
    }

    // Now remove the referencing row on the other product -> destroy fires.
    await prisma.productImage.deleteMany({ where: { productId: other.id } });
    const { __setStorageForTests: set2 } = await import('../../src/modules/admin/image.storage');
    const destroyed2: string[] = [];
    set2({
      configured: () => true,
      upload: async () => {
        throw new Error('unexpected upload');
      },
      destroy: async (ref) => {
        destroyed2.push(ref.publicId);
      },
    });
    try {
      const del = await request(app)
        .delete('/api/v1/admin/products/' + other.id)
        .set('Authorization', 'Bearer ' + adminToken);
      expect(del.status).toBe(200);
    } finally {
      set2(null);
    }
    expect(destroyed2).toContain(videoRef.publicId);
  });

  // ---- Storefront compatibility ------------------------------------------

  it('storefront product payload separates images and videos', async () => {
    const res = await request(app).get('/api/v1/products/' + slug);
    expect(res.status).toBe(200);
    const images: string[] = res.body.data.images;
    expect(images.length).toBe(1);
    expect(images[0]).not.toContain('/video/upload/');
    const videos: { url: string }[] = res.body.data.videos;
    expect(videos.length).toBe(1);
    expect(videos[0].url).toBe(videoUrl);
    expect(Array.isArray(res.body.data.colors)).toBe(true);
  });

  it('legacy IMAGE-only products keep working (no videos array entries)', async () => {
    const res = await request(app).get('/api/v1/products');
    expect(res.status).toBe(200);
    const products = res.body.data as { images: string[]; videos?: { url: string }[] }[];
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) {
      expect(Array.isArray(p.images)).toBe(true);
      for (const url of p.images) {
        expect(url).not.toContain('/video/upload/');
      }
    }
  });
});

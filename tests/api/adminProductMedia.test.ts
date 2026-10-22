import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// Integration test: requires a running Postgres and a migrated+seeded DB.
// Skips automatically when DATABASE_URL is not configured.
//
// Covers the product MEDIA feature (images AND videos):
// - POST /admin/videos: 401/403, 400 empty / bad magic / oversized (100 MB),
//   503 when storage is unconfigured, 502 when Cloudinary fails,
//   201 with media metadata (fake storage injected)
// - POST /admin/images: 400 for a video payload (magic-byte check)
// - Product create + PATCH persisting mixed images and videos (mediaType,
//   publicId, format, dimensions, duration)
// - Storefront serialization: GET /products/:slug returns images (IMAGE rows
//   only) and a separate videos array; existing image-only products unchanged
// - Media deletion reference safety: an asset shared by two products is only
//   destroyed after the LAST reference is removed
//
// No real Cloudinary credentials are used: CI injects a fake implementation
// through the __setStorageForTests seam.

const run = process.env.DATABASE_URL ? describe : describe.skip;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
// MP4: 4-byte size then 'ftyp' box with 'isom' brand
const MP4_MAGIC = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
// WebM/Matroska EBML header
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);

run('admin product media (images + videos, integration)', () => {
  const prisma = new PrismaClient();
  let app: import('express').Express;
  let adminToken = '';
  const stamp = Date.now();
  const slug = 'ci-media-product-' + stamp;
  const sku = 'KIEN-MEDIA-' + stamp;
  const createdProductIds: string[] = [];

  const productBody = (overrides: Record<string, unknown> = {}) => ({
    slug,
    name: 'CI Media Product',
    shortDescription: 'Created by the product-media integration test.',
    description: 'A product created by the automated media integration test to verify images and videos persist.',
    categorySlug: 'bags',
    collectionSlug: 'athlete-series',
    status: 'ACTIVE',
    price: 1499,
    isFeatured: false,
    isNewArrival: false,
    isBestSeller: false,
    materials: ['600D Ripstop Nylon'],
    tags: ['test'],
    images: [
      { url: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800&h=1000&fit=crop&q=80', alt: 'CI Media Product 1', mediaType: 'IMAGE' },
      {
        url: 'https://res.cloudinary.com/test/video/upload/v1/kiensports/products/fake-video-1.mp4',
        alt: 'CI Media Product video',
        mediaType: 'VIDEO',
        publicId: 'kiensports/products/fake-video-1',
        format: 'mp4',
        width: 1920,
        height: 1080,
        durationSeconds: 42,
      },
    ],
    features: [{ title: 'Media Feature', description: 'Integration test feature.', icon: 'package' }],
    variants: [{ sku, colorName: 'Matte Black', colorHex: '#1a1a1a', inventoryQty: 7 }],
    ...overrides,
  });

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
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'Password1234' });
    expect(login.status).toBe(200);
    adminToken = login.body.data.accessToken as string;
  });

  afterAll(async () => {
    for (const id of createdProductIds) {
      await prisma.product.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  const injectFakeStorage = (behavior: {
    uploadImage?: (buffer: Buffer, filename: string) => Promise<Record<string, unknown>> | never;
    uploadVideo?: (buffer: Buffer, filename: string) => Promise<Record<string, unknown>>;
    destroyed?: string[];
  } = {}) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return import('../../src/modules/admin/media.storage').then((mod) => {
      const n = { image: 0, video: 0 };
      mod.__setStorageForTests({
        configured: () => true,
        missingEnvVars: () => [],
        uploadImage: async (buffer: Buffer, filename: string) => {
          if (behavior.uploadImage === undefined) {
            n.image += 1;
            return {
              url: 'https://res.cloudinary.com/test/image/upload/v1/kiensports/products/fake-image-' + n.image + '.png',
              publicId: 'kiensports/products/fake-image-' + n.image,
              resourceType: 'image' as const,
              format: 'png',
              width: 800,
              height: 1000,
              durationSeconds: null,
            };
          }
          return behavior.uploadImage(buffer, filename) as never;
        },
        uploadVideo: async (buffer: Buffer, filename: string) => {
          if (behavior.uploadVideo === undefined) {
            n.video += 1;
            return {
              url: 'https://res.cloudinary.com/test/video/upload/v1/kiensports/products/fake-video-' + n.video + '.mp4',
              publicId: 'kiensports/products/fake-video-' + n.video,
              resourceType: 'video' as const,
              format: 'mp4',
              width: 1920,
              height: 1080,
              durationSeconds: 30 + n.video,
            };
          }
          return behavior.uploadVideo(buffer, filename);
        },
        destroy: async (asset: { url: string; publicId: string | null }) => {
          behavior.destroyed?.push(asset.url);
        },
      });
      return () => mod.__setStorageForTests(null);
    });
  };

  it('401/403 on the video upload endpoint', async () => {
    const anon = await request(app)
      .post('/api/v1/admin/videos')
      .set('Content-Type', 'application/octet-stream')
      .send(MP4_MAGIC);
    expect(anon.status).toBe(401);
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'ci-media-cust-' + stamp + '@example.com', password: 'Password123', firstName: 'T', lastName: 'U' });
    expect(reg.status).toBe(201);
    const customer = await request(app)
      .post('/api/v1/admin/videos')
      .set('Authorization', 'Bearer ' + reg.body.data.accessToken)
      .set('Content-Type', 'application/octet-stream')
      .send(MP4_MAGIC);
    expect(customer.status).toBe(403);
  });

  it('reports 503 STORAGE_NOT_CONFIGURED on videos when env vars are unset', async () => {
    const res = await request(app)
      .post('/api/v1/admin/videos')
      .set('Authorization', 'Bearer ' + adminToken)
      .set('Content-Type', 'application/octet-stream')
      .send(MP4_MAGIC);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_NOT_CONFIGURED');
  });

  it('rejects an empty video upload with 400', async () => {
    const res = await request(app)
      .post('/api/v1/admin/videos')
      .set('Authorization', 'Bearer ' + adminToken)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
  });

  it('rejects a non-video payload on /videos with 400 (magic-byte check)', async () => {
    const res = await request(app)
      .post('/api/v1/admin/videos')
      .set('Authorization', 'Bearer ' + adminToken)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('this is definitely not a video'));
    expect(res.status).toBe(400);
  });

  it('rejects a video payload on /images with 400 (magic-byte check)', async () => {
    const res = await request(app)
      .post('/api/v1/admin/images')
      .set('Authorization', 'Bearer ' + adminToken)
      .set('Content-Type', 'application/octet-stream')
      .send(MP4_MAGIC);
    expect(res.status).toBe(400);
  });

  it('rejects an image larger than 5 MB with 400', async () => {
    const res = await request(app)
      .post('/api/v1/admin/images')
      .set('Authorization', 'Bearer ' + adminToken)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.concat([PNG_MAGIC, Buffer.alloc(5 * 1024 * 1024, 0x00)]));
    expect(res.status).toBe(400);
  });

  it('rejects a video larger than 100 MB with 400', async () => {
    const res = await request(app)
      .post('/api/v1/admin/videos')
      .set('Authorization', 'Bearer ' + adminToken)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.concat([MP4_MAGIC, Buffer.alloc(100 * 1024 * 1024, 0x00)]));
    expect(res.status).toBe(400);
  });

  it('accepts a valid PNG (201, IMAGE metadata) with fake storage', async () => {
    const reset = await injectFakeStorage();
    try {
      const png = Buffer.concat([PNG_MAGIC, Buffer.alloc(64, 0x00)]);
      const res = await request(app)
        .post('/api/v1/admin/images?filename=test.png')
        .set('Authorization', 'Bearer ' + adminToken)
        .set('Content-Type', 'application/octet-stream')
        .send(png);
      expect(res.status).toBe(201);
      expect(res.body.data.mediaType).toBe('IMAGE');
      expect(String(res.body.data.url)).toContain('https://res.cloudinary.com/test/');
    } finally {
      await reset();
    }
  });

  it('accepts a valid MP4 (201, VIDEO metadata + duration) with fake storage', async () => {
    const reset = await injectFakeStorage();
    try {
      const mp4 = Buffer.concat([MP4_MAGIC, Buffer.alloc(64, 0x00)]);
      const res = await request(app)
        .post('/api/v1/admin/videos?filename=test.mp4')
        .set('Authorization', 'Bearer ' + adminToken)
        .set('Content-Type', 'application/octet-stream')
        .send(mp4);
      expect(res.status).toBe(201);
      expect(res.body.data.mediaType).toBe('VIDEO');
      expect(res.body.data.durationSeconds).toBeGreaterThan(0);
      expect(String(res.body.data.url)).toContain('https://res.cloudinary.com/test/');
    } finally {
      await reset();
    }
  });

  it('accepts a valid WebM (201) with fake storage', async () => {
    const reset = await injectFakeStorage();
    try {
      const res = await request(app)
        .post('/api/v1/admin/videos?filename=test.webm')
        .set('Authorization', 'Bearer ' + adminToken)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.concat([WEBM_MAGIC, Buffer.alloc(64, 0x00)]));
      expect(res.status).toBe(201);
      expect(res.body.data.mediaType).toBe('VIDEO');
    } finally {
      await reset();
    }
  });

  it('surfaces a failed Cloudinary upload as 502 STORAGE_ERROR (never as success)', async () => {
    const reset = await injectFakeStorage({
      uploadVideo: async () => {
        throw new Error('simulated cloudinary failure');
      },
    });
    try {
      const res = await request(app)
        .post('/api/v1/admin/videos')
        .set('Authorization', 'Bearer ' + adminToken)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.concat([MP4_MAGIC, Buffer.alloc(64, 0x00)]));
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('STORAGE_ERROR');
    } finally {
      await reset();
    }
  });

  it('creates a product with mixed images and videos and persists media metadata', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', 'Bearer ' + adminToken)
      .send(productBody());
    expect(res.status).toBe(201);
    createdProductIds.push(res.body.data.id as string);

    const detail = await request(app)
      .get('/api/v1/admin/catalog/products/' + slug)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(detail.status).toBe(200);
    const images = detail.body.data.images as { url: string; mediaType: string; publicId: string | null; durationSeconds: number | null }[];
    expect(images.length).toBe(2);
    expect(images[0].mediaType).toBe('IMAGE');
    expect(images[1].mediaType).toBe('VIDEO');
    expect(images[1].publicId).toBe('kiensports/products/fake-video-1');
    expect(images[1].durationSeconds).toBe(42);
  });

  it('serializes the storefront product with images and videos split', async () => {
    const res = await request(app).get('/api/v1/products/' + slug);
    expect(res.status).toBe(200);
    expect(res.body.data.images.length).toBe(1); // IMAGE rows only
    expect(res.body.data.images[0]).toContain('images.unsplash.com');
    const videos = res.body.data.videos as { url: string; durationSeconds: number | null }[];
    expect(videos.length).toBe(1);
    expect(videos[0].url).toContain('fake-video-1');
    expect(videos[0].durationSeconds).toBe(42);
  });

  it('keeps existing image-only products unchanged (backward compatibility)', async () => {
    const seeded = await prisma.product.findFirst({ where: { slug: 'kien-athlete-40l' } });
    expect(seeded).toBeTruthy();
    const res = await request(app).get('/api/v1/products/kien-athlete-40l');
    expect(res.status).toBe(200);
    expect(res.body.data.images.length).toBeGreaterThan(0);
    expect(res.body.data.images.every((u: unknown) => typeof u === 'string')).toBe(true);
    expect((res.body.data.videos ?? []).length).toBe(0);
  });

  it('PATCH retains media and updates video metadata', async () => {
    const detail = await request(app)
      .get('/api/v1/admin/catalog/products/' + slug)
      .set('Authorization', 'Bearer ' + adminToken);
    const images = detail.body.data.images as { id: string; url: string; mediaType: string; publicId: string | null; format: string | null; width: number | null; height: number | null; durationSeconds: number | null }[];
    const res = await request(app)
      .patch('/api/v1/admin/products/' + createdProductIds[0])
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        images: [
          images[1], // keep the video, now first
          { ...images[0], alt: 'Updated alt' }, // keep the image
          { url: 'https://images.unsplash.com/photo-1547949003-9792a18a2601?w=800&h=1000&fit=crop&q=80', mediaType: 'IMAGE' }, // add
        ],
      });
    expect(res.status).toBe(200);

    const after = await request(app)
      .get('/api/v1/admin/catalog/products/' + slug)
      .set('Authorization', 'Bearer ' + adminToken);
    const afterImages = after.body.data.images as { url: string; mediaType: string; alt: string | null }[];
    expect(afterImages.length).toBe(3);
    expect(afterImages[0].mediaType).toBe('VIDEO'); // reorder persisted
    expect(afterImages[1].alt).toBe('Updated alt');
    expect(afterImages[2].mediaType).toBe('IMAGE');
  });

  it('destroys a removed asset only after its LAST product reference is gone', async () => {
    const sharedUrl = 'https://res.cloudinary.com/test/image/upload/v1/kiensports/products/shared-asset.png';
    const shared = {
      url: sharedUrl,
      alt: 'Shared',
      mediaType: 'IMAGE' as const,
      publicId: 'kiensports/products/shared-asset',
      format: 'png',
      width: 800,
      height: 800,
    };
    const a = await request(app).post('/api/v1/admin/products').set('Authorization', 'Bearer ' + adminToken).send(productBody({ slug: slug + '-a', name: 'CI Media A', variants: [{ sku: sku + '-A', colorName: 'Red', colorHex: '#aa1111', inventoryQty: 1 }], images: [shared] }));
    const b = await request(app).post('/api/v1/admin/products').set('Authorization', 'Bearer ' + adminToken).send(productBody({ slug: slug + '-b', name: 'CI Media B', variants: [{ sku: sku + '-B', colorName: 'Blue', colorHex: '#1111aa', inventoryQty: 1 }], images: [shared] }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    createdProductIds.push(a.body.data.id, b.body.data.id);

    const destroyed: string[] = [];
    const reset = await injectFakeStorage({ destroyed });
    try {
      // Remove the shared asset from A: still referenced by B -> NOT destroyed.
      const removeA = await request(app)
        .patch('/api/v1/admin/products/' + a.body.data.id)
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ images: [] });
      expect(removeA.status).toBe(200);
      expect(destroyed).toEqual([]);

      // Remove from B as well: last reference gone -> destroyed exactly once.
      const removeB = await request(app)
        .patch('/api/v1/admin/products/' + b.body.data.id)
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ images: [] });
      expect(removeB.status).toBe(200);
      expect(destroyed).toEqual([sharedUrl]);
    } finally {
      await reset();
    }
  });

  it('never destroys external (non-Cloudinary) urls on media removal', async () => {
    const destroyed: string[] = [];
    const reset = await injectFakeStorage({ destroyed });
    try {
      const detail = await request(app)
        .get('/api/v1/admin/catalog/products/' + createdProductIds[0])
        .set('Authorization', 'Bearer ' + adminToken);
      const images = detail.body.data.images as { id: string; url: string }[];
      const external = images.filter((i) => i.url.includes('images.unsplash.com'));
      expect(external.length).toBeGreaterThan(0);
      const res = await request(app)
        .patch('/api/v1/admin/products/' + createdProductIds[0])
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ images: [] });
      expect(res.status).toBe(200);
      expect(destroyed.filter((u) => u.includes('images.unsplash.com'))).toEqual([]);
    } finally {
      await reset();
    }
  });
});

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Product media storage (Cloudinary, signed REST upload - no SDK dependency).
//
// Product media must live in external object storage: the Render service
// filesystem is ephemeral, so anything written locally is lost on the next
// deploy. The backend only ever stores the resulting HTTPS url plus a few
// metadata columns in the ProductImage table (no blobs in the database).
//
// Configuration (server-side env only, NEVER exposed to the frontend):
//   CLOUDINARY_CLOUD_NAME   (required)
//   CLOUDINARY_API_KEY      (required)
//   CLOUDINARY_API_SECRET   (required)
//   CLOUDINARY_FOLDER_NAME  (optional; defaults to "kiensports/products")
// When a required variable is missing OR EMPTY, the upload endpoints return
// 503 STORAGE_NOT_CONFIGURED and name exactly which variables are missing
// (names only - values are never logged or returned).
//
// Cloudinary separates images and videos by resource type:
//   upload:  POST /v1_1/<cloud>/image/upload  |  /v1_1/<cloud>/video/upload
//   destroy: POST /v1_1/<cloud>/image/destroy |  /v1_1/<cloud>/video/destroy
// The correct endpoint is chosen from the server-side magic-byte detection,
// never from the filename or client-supplied Content-Type.
// ---------------------------------------------------------------------------

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB per video (Cloudinary free-plan cap)

export type MediaType = 'IMAGE' | 'VIDEO';
export type DetectedKind = 'jpeg' | 'png' | 'webp' | 'mp4' | 'webm';

export interface DetectedMedia {
  kind: DetectedKind;
  mediaType: MediaType;
}

export interface StoredMedia {
  url: string;
  publicId: string;
  resourceType: 'image' | 'video';
  format: string;
}

/** Reference to a stored asset, used for safe destruction. */
export interface StoredMediaRef {
  url: string;
  publicId: string | null;
  resourceType: string | null;
}

export interface StorageImpl {
  configured(): boolean;
  upload(buffer: Buffer, filename: string, mediaType: MediaType): Promise<StoredMedia>;
  destroy(ref: { publicId: string; resourceType: string }): Promise<void>;
}

// ---- Environment ----------------------------------------------------------

const envValue = (name: string): string | null => {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Names of required Cloudinary variables that are missing or empty. */
export const missingCloudinaryVars = (): string[] =>
  ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'].filter((n) => envValue(n) === null);

function signCloudinary(params: Record<string, string>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

const cloudinaryImpl: StorageImpl = {
  configured() {
    return missingCloudinaryVars().length === 0;
  },

  async upload(buffer, filename, mediaType) {
    const cloudName = envValue('CLOUDINARY_CLOUD_NAME')!;
    const apiKey = envValue('CLOUDINARY_API_KEY')!;
    const apiSecret = envValue('CLOUDINARY_API_SECRET')!;
    const folder = envValue('CLOUDINARY_FOLDER_NAME') ?? 'kiensports/products';
    const resourceType: 'image' | 'video' = mediaType === 'VIDEO' ? 'video' : 'image';
    const publicId = crypto.randomUUID();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signCloudinary({ folder, public_id: publicId, timestamp }, apiSecret);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)]), filename || 'upload');
    form.append('api_key', apiKey);
    form.append('timestamp', timestamp);
    form.append('folder', folder);
    form.append('public_id', publicId);
    form.append('signature', signature);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(resourceType === 'video' ? 120_000 : 30_000),
    });
    if (!res.ok) throw new Error(`Cloudinary upload failed with status ${res.status}`);
    const json = (await res.json()) as {
      secure_url?: string;
      public_id?: string;
      format?: string;
      resource_type?: string;
    };
    if (!json.secure_url || !json.public_id) throw new Error('Cloudinary upload returned no url');
    return {
      url: json.secure_url,
      publicId: json.public_id,
      resourceType,
      format: json.format ?? '',
    };
  },

  async destroy(ref) {
    const cloudName = envValue('CLOUDINARY_CLOUD_NAME')!;
    const apiKey = envValue('CLOUDINARY_API_KEY')!;
    const apiSecret = envValue('CLOUDINARY_API_SECRET')!;
    const resourceType = ref.resourceType === 'video' ? 'video' : 'image';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signCloudinary({ public_id: ref.publicId, timestamp }, apiSecret);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/destroy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ public_id: ref.publicId, timestamp, api_key: apiKey, signature }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Cloudinary destroy failed with status ${res.status}`);
  },
};

let impl: StorageImpl = cloudinaryImpl;

/** Test seam: inject a fake storage implementation (CI has no Cloudinary). */
export const __setStorageForTests = (next: StorageImpl | null): void => {
  impl = next ?? cloudinaryImpl;
};

// Size limits are read through these helpers so tests can exercise the
// oversize guards without shipping multi-megabyte fixtures through CI.
let limits = { image: MAX_IMAGE_BYTES, video: MAX_VIDEO_BYTES };
export const __setMediaLimitsForTests = (next: { image?: number; video?: number } | null): void => {
  limits = { image: next?.image ?? MAX_IMAGE_BYTES, video: next?.video ?? MAX_VIDEO_BYTES };
};
export const maxImageBytes = (): number => limits.image;
export const maxVideoBytes = (): number => limits.video;

export const imageStorageConfigured = (): boolean => impl.configured();

/**
 * Extract { publicId, resourceType } from one of our delivery urls:
 *   https://res.cloudinary.com/<cloud>/image/upload/v123/<publicid>.<ext>
 *   https://res.cloudinary.com/<cloud>/video/upload/v123/<publicid>.<ext>
 * Returns null when the url does not belong to our Cloudinary cloud.
 */
export function parseStoredUrl(url: string): { publicId: string; resourceType: 'image' | 'video' } | null {
  const cloudName = envValue('CLOUDINARY_CLOUD_NAME');
  if (!cloudName) return null;
  for (const resourceType of ['image', 'video'] as const) {
    const prefix = `https://res.cloudinary.com/${cloudName}/${resourceType}/upload/`;
    if (!url.startsWith(prefix)) continue;
    const segments = url
      .slice(prefix.length)
      .split('?')[0]
      .split('/');
    if (segments.length > 1 && /^v\d+$/.test(segments[0])) segments.shift(); // strip version
    const last = segments[segments.length - 1];
    const dot = last.lastIndexOf('.');
    if (dot > 0) segments[segments.length - 1] = last.slice(0, dot);
    const id = segments.join('/');
    if (!id) return null;
    return { publicId: id, resourceType };
  }
  return null;
}

/** True when the url points into our own Cloudinary storage (safe to destroy). */
export const isOurStorageUrl = (url: string): boolean => parseStoredUrl(url) !== null;

/**
 * Detect the real media type from magic bytes. Never trust the filename or
 * the browser-supplied Content-Type.
 */
export function detectMediaType(buf: Buffer): DetectedMedia | null {
  if (buf.length < 12) return null;
  // Images
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'jpeg', mediaType: 'IMAGE' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { kind: 'png', mediaType: 'IMAGE' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { kind: 'webp', mediaType: 'IMAGE' };
  }
  // Videos
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return { kind: 'mp4', mediaType: 'VIDEO' }; // MP4/MOV container
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { kind: 'webm', mediaType: 'VIDEO' }; // EBML header (WebM/MKV)
  }
  return null;
}

/** Backwards-compatible image-only detection (used by the legacy /images route). */
export function detectImageType(buf: Buffer): 'jpeg' | 'png' | 'webp' | null {
  const detected = detectMediaType(buf);
  return detected && detected.mediaType === 'IMAGE' ? detected.kind : null;
}

export const uploadMedia = (buffer: Buffer, filename: string, mediaType: MediaType): Promise<StoredMedia> =>
  impl.upload(buffer, filename, mediaType);

/**
 * Best-effort removal of a stored asset. Uses the stored publicId/resourceType
 * when the row has them; otherwise parses the delivery url. Assets that are
 * not in our storage (e.g. legacy Unsplash urls) are left untouched. Storage
 * errors never bubble up - the product row is already gone at this point.
 */
export const destroyImage = async (ref: StoredMediaRef): Promise<void> => {
  try {
    const resolved = ref.publicId && ref.resourceType
      ? { publicId: ref.publicId, resourceType: ref.resourceType }
      : parseStoredUrl(ref.url);
    if (!resolved) return; // not one of ours - leave it alone
    await impl.destroy(resolved);
  } catch (err) {
    console.error('media destroy failed (ignored, asset left orphaned):', err instanceof Error ? err.message : err);
  }
};

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Product image storage (Cloudinary, signed REST upload - no SDK dependency).
//
// Product images must live in external object storage: the Render service
// filesystem is ephemeral, so anything written locally is lost on the next
// deploy. The backend only ever stores the resulting HTTPS url in the
// ProductImage table (no base64 blobs in the database).
//
// Configuration (server-side env only, NEVER exposed to the frontend):
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
// When these are unset the upload endpoint returns 503 STORAGE_NOT_CONFIGURED
// instead of failing silently.
// ---------------------------------------------------------------------------

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image

export interface StoredImage {
  url: string;
  publicId: string;
}

export interface StorageImpl {
  configured(): boolean;
  upload(buffer: Buffer, filename: string): Promise<StoredImage>;
  destroy(url: string): Promise<void>;
}

function signCloudinary(params: Record<string, string>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

const cloudinaryImpl: StorageImpl = {
  configured() {
    return Boolean(
      process.env.CLOUDINARY_CLOUD_NAME &&
        process.env.CLOUDINARY_API_KEY &&
        process.env.CLOUDINARY_API_SECRET,
    );
  },

  async upload(buffer, filename) {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
    const apiKey = process.env.CLOUDINARY_API_KEY!;
    const apiSecret = process.env.CLOUDINARY_API_SECRET!;
    const folder = 'kiensports/products';
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

    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) throw new Error(`Cloudinary upload failed with status ${res.status}`);
    const json = (await res.json()) as { secure_url?: string; public_id?: string };
    if (!json.secure_url || !json.public_id) throw new Error('Cloudinary upload returned no url');
    return { url: json.secure_url, publicId: json.public_id };
  },

  async destroy(url) {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
    const apiKey = process.env.CLOUDINARY_API_KEY!;
    const apiSecret = process.env.CLOUDINARY_API_SECRET!;
    const publicId = publicIdFromUrl(url);
    if (!publicId) return; // not one of ours - leave it alone
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signCloudinary({ public_id: publicId, timestamp }, apiSecret);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ public_id: publicId, timestamp, api_key: apiKey, signature }).toString(),
    });
    if (!res.ok) throw new Error(`Cloudinary destroy failed with status ${res.status}`);
  },
};

let impl: StorageImpl = cloudinaryImpl;

/** Test seam: inject a fake storage implementation (CI has no Cloudinary). */
export const __setStorageForTests = (next: StorageImpl | null): void => {
  impl = next ?? cloudinaryImpl;
};

export const imageStorageConfigured = (): boolean => impl.configured();

/**
 * Extract the Cloudinary public id from one of our delivery urls:
 * https://res.cloudinary.com/<cloud>/image/upload/v123/<publicid>.<ext>
 * Returns null when the url does not belong to our Cloudinary cloud.
 */
export function publicIdFromUrl(url: string): string | null {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) return null;
  const prefix = `https://res.cloudinary.com/${cloudName}/image/upload/`;
  if (!url.startsWith(prefix)) return null;
  const segments = url
    .slice(prefix.length)
    .split('?')[0]
    .split('/');
  if (segments.length > 1 && /^v\d+$/.test(segments[0])) segments.shift(); // strip version
  const last = segments[segments.length - 1];
  const dot = last.lastIndexOf('.');
  if (dot > 0) segments[segments.length - 1] = last.slice(0, dot);
  const id = segments.join('/');
  return id || null;
}

/** True when the url points into our own Cloudinary storage (safe to destroy). */
export const isOurStorageUrl = (url: string): boolean => publicIdFromUrl(url) !== null;

/**
 * Detect the real image type from magic bytes. Never trust the filename or
 * the browser-supplied Content-Type.
 */
export function detectImageType(buf: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export const uploadImage = (buffer: Buffer, filename: string): Promise<StoredImage> =>
  impl.upload(buffer, filename);

/** Best-effort removal of a stored image; storage errors never bubble up. */
export const destroyImage = async (url: string): Promise<void> => {
  try {
    await impl.destroy(url);
  } catch (err) {
    console.error('image destroy failed (ignored, url left orphaned):', err instanceof Error ? err.message : err);
  }
};

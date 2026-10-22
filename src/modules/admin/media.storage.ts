import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Product media storage (Cloudinary, signed REST - no SDK dependency).
//
// Product images AND videos must live in external object storage: the Render
// service filesystem is ephemeral. Only the resulting HTTPS url plus asset
// metadata (public id, format, dimensions, duration) is stored in the DB.
//
// Configuration (server-side env only, NEVER exposed to the frontend):
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
//   CLOUDINARY_FOLDER_NAME   (optional; defaults to kiensports/products)
//
// Values are trimmed and re-read from process.env on every call, so a Render
// restart after changing dashboard env vars is enough - there is no
// module-load snapshot. When the three required variables are missing (or
// blank/whitespace), upload endpoints return 503 STORAGE_NOT_CONFIGURED and
// the exact missing variable NAMES are logged (never their values).
//
// Cloudinary free-plan limits (see Cloudinary docs / support):
//   images/raw: 10 MB per file; videos: 100 MB per file.
// Videos larger than 20 MB are uploaded to Cloudinary in 5 MB chunks
// (X-Unique-Upload-Id + Content-Range), matching the documented chunked
// upload protocol for large videos.
// ---------------------------------------------------------------------------

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image (below the 10 MB plan limit)
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB per video (Cloudinary free-plan limit)
const VIDEO_CHUNK_THRESHOLD = 20 * 1024 * 1024; // above this, upload in chunks
const VIDEO_CHUNK_SIZE = 5 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120_000;
const VIDEO_CHUNK_TIMEOUT_MS = 300_000;
const DEFAULT_FOLDER = 'kiensports/products';

export type MediaType = 'IMAGE' | 'VIDEO';

export interface StoredMedia {
  url: string;
  publicId: string;
  resourceType: 'image' | 'video';
  format: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

/** Reference to a stored asset, used for safe best-effort destruction. */
export interface StoredAssetRef {
  url: string;
  publicId: string | null;
  mediaType: MediaType;
}

export interface StorageImpl {
  configured(): boolean;
  /** Names of required env vars missing/blank in the running process (no values). */
  missingEnvVars(): string[];
  uploadImage(buffer: Buffer, filename: string): Promise<StoredMedia>;
  uploadVideo(buffer: Buffer, filename: string): Promise<StoredMedia>;
  destroy(asset: StoredAssetRef): Promise<void>;
}

// ---- Environment ----------------------------------------------------------

const REQUIRED_ENV_VARS = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'] as const;

/** Trimmed env value: protects against stray whitespace/quotes from the dashboard. */
const envValue = (name: string): string => (process.env[name] ?? '').trim();

const missingEnvVarNames = (): string[] => REQUIRED_ENV_VARS.filter((n) => !envValue(n));

const cloudName = () => envValue('CLOUDINARY_CLOUD_NAME');
const apiKey = () => envValue('CLOUDINARY_API_KEY');
const apiSecret = () => envValue('CLOUDINARY_API_SECRET');
const folderName = () => envValue('CLOUDINARY_FOLDER_NAME') || DEFAULT_FOLDER;

// ---- Cloudinary REST helpers ----------------------------------------------

function signCloudinary(params: Record<string, string>, secret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + secret).digest('hex');
}

const parseUploadResponse = (json: Record<string, unknown>): StoredMedia & { resourceType: 'image' | 'video' } => {
  const url = json.secure_url as string | undefined;
  const publicId = json.public_id as string | undefined;
  if (!url || !publicId) throw new Error('Cloudinary upload returned no url');
  return {
    url,
    publicId,
    resourceType: (json.resource_type as 'image' | 'video') ?? 'image',
    format: (json.format as string | undefined) ?? null,
    width: typeof json.width === 'number' ? json.width : null,
    height: typeof json.height === 'number' ? json.height : null,
    durationSeconds: typeof json.duration === 'number' ? Math.round(json.duration) : null,
  };
};

const signedFormFields = (publicId: string): FormData => {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signCloudinary({ folder: folderName(), public_id: publicId, timestamp }, apiSecret());
  const form = new FormData();
  form.append('api_key', apiKey());
  form.append('timestamp', timestamp);
  form.append('folder', folderName());
  form.append('public_id', publicId);
  form.append('signature', signature);
  return form;
};

const uploadEndpoint = (resourceType: 'image' | 'video'): string =>
  `https://api.cloudinary.com/v1_1/${cloudName()}/${resourceType}/upload`;

const cloudinaryImpl: StorageImpl = {
  configured() {
    return missingEnvVarNames().length === 0;
  },

  missingEnvVars() {
    return missingEnvVarNames();
  },

  async uploadImage(buffer, filename) {
    if (!this.configured()) throw new Error('Cloudinary is not configured');
    const publicId = crypto.randomUUID();
    const form = signedFormFields(publicId);
    form.append('file', new Blob([new Uint8Array(buffer)]), filename || 'upload.jpg');
    const res = await fetch(uploadEndpoint('image'), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Cloudinary image upload failed with status ${res.status}`);
    return parseUploadResponse(await res.json());
  },

  async uploadVideo(buffer, filename) {
    if (!this.configured()) throw new Error('Cloudinary is not configured');
    const publicId = crypto.randomUUID();
    const total = buffer.length;

    // Small videos: one signed request. Larger videos: chunked upload
    // (X-Unique-Upload-Id + Content-Range per chunk; last chunk returns the
    // upload response). Each request carries the same signed params.
    if (total <= VIDEO_CHUNK_THRESHOLD) {
      const form = signedFormFields(publicId);
      form.append('file', new Blob([new Uint8Array(buffer)]), filename || 'upload.mp4');
      const res = await fetch(uploadEndpoint('video'), {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Cloudinary video upload failed with status ${res.status}`);
      return parseUploadResponse(await res.json());
    }

    const uploadId = crypto.randomUUID();
    const url = uploadEndpoint('video');
    for (let offset = 0; offset < total; offset += VIDEO_CHUNK_SIZE) {
      const chunk = buffer.subarray(offset, Math.min(offset + VIDEO_CHUNK_SIZE, total));
      const contentRange = `bytes ${offset}-${offset + chunk.length - 1}/${total}`;
      const sendChunk = async (): Promise<Response> => {
        const form = signedFormFields(publicId);
        form.append('file', new Blob([new Uint8Array(chunk)]), filename || 'upload.mp4');
        return fetch(url, {
          method: 'POST',
          headers: { 'X-Unique-Upload-Id': uploadId, 'Content-Range': contentRange },
          body: form,
          signal: AbortSignal.timeout(VIDEO_CHUNK_TIMEOUT_MS),
        });
      };
      let res = await sendChunk();
      if (res.status >= 500) res = await sendChunk(); // one retry per chunk
      if (!res.ok) throw new Error(`Cloudinary chunked video upload failed with status ${res.status} (${contentRange})`);
      if (offset + chunk.length >= total) {
        return parseUploadResponse(await res.json());
      }
    }
    throw new Error('Cloudinary chunked video upload finished without a final response');
  },

  async destroy(asset) {
    const publicId = asset.publicId ?? publicIdFromUrl(asset.url);
    if (!publicId) return; // not one of ours - leave it alone
    const resourceType = asset.mediaType === 'VIDEO' ? 'video' : 'image';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signCloudinary({ public_id: publicId, timestamp }, apiSecret());
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName()}/${resourceType}/destroy`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ public_id: publicId, timestamp, api_key: apiKey(), signature }).toString(),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) throw new Error(`Cloudinary destroy failed with status ${res.status}`);
  },
};

let impl: StorageImpl = cloudinaryImpl;

/** Test seam: inject a fake storage implementation (CI has no Cloudinary). */
export const __setStorageForTests = (next: StorageImpl | null): void => {
  impl = next ?? cloudinaryImpl;
};

export const mediaStorageConfigured = (): boolean => impl.configured();

/** Missing required env var NAMES in the running process (values never included). */
export const missingStorageEnvVars = (): string[] => impl.missingEnvVars();

/**
 * Extract the Cloudinary public id from one of our delivery urls
 * (image or video). Returns null for urls outside our cloud.
 */
export function publicIdFromUrl(url: string): string | null {
  const name = cloudName();
  if (!name) return null;
  for (const resourceType of ['image', 'video'] as const) {
    const prefix = `https://res.cloudinary.com/${name}/${resourceType}/upload/`;
    if (!url.startsWith(prefix)) continue;
    const segments = url
      .slice(prefix.length)
      .split('?')[0]
      .split('/');
    if (segments.length > 1 && /^v\d+$/.test(segments[0])) segments.shift(); // strip version
    const last = segments[segments.length - 1];
    const dot = last.lastIndexOf('.');
    if (dot > 0) segments[segments.length - 1] = last.slice(0, dot);
    return segments.join('/') || null;
  }
  return null;
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

/**
 * Detect the real video type from magic bytes: MP4/MOV carry an 'ftyp'
 * box at offset 4; WebM/Matroska start with the EBML magic 1A45DFA3.
 * Accepts MP4, WebM and MOV (the common web video formats Cloudinary
 * transcodes). Everything else is rejected.
 */
export function detectVideoType(buf: Buffer): 'mp4' | 'webm' | 'mov' | null {
  if (buf.length < 12) return null;
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'qt  ') return 'mov';
    return 'mp4'; // isom, iso2, mp41, mp42, avc1, dash, msnv, ...
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}

export const uploadImage = (buffer: Buffer, filename: string): Promise<StoredMedia> =>
  impl.uploadImage(buffer, filename);

export const uploadVideo = (buffer: Buffer, filename: string): Promise<StoredMedia> =>
  impl.uploadVideo(buffer, filename);

/** Best-effort removal of a stored asset; storage errors never bubble up. */
export const destroyMedia = async (asset: StoredAssetRef): Promise<void> => {
  try {
    await impl.destroy(asset);
  } catch (err) {
    console.error('media destroy failed (ignored, asset left orphaned):', err instanceof Error ? err.message : err);
  }
};

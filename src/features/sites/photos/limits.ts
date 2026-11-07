// What a mini-site photo may be (docs/SITE_PUBLISHING_CONTRACT.md § 8).
// Shared by the studio (its file picker) and the server (its checks).

/** The widths served: phones, phones at 2x/3x and tablets, desktop. */
export const SITE_PHOTO_WIDTHS = [480, 828, 1200] as const;
export type SitePhotoWidth = (typeof SITE_PHOTO_WIDTHS)[number];

/**
 * The types the server decodes. Not HEIC: the studio's picker accepts only
 * these, so iOS converts a HEIC photo to JPEG when she picks it.
 */
export const SITE_PHOTO_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;
export type SitePhotoType = (typeof SITE_PHOTO_UPLOAD_TYPES)[number];

export const sitePhotoLimits = {
  /** The bucket refuses more; checked again on the bytes received. */
  maxBytes: 10 * 1024 * 1024,
  /** Decompression bombs: refused before decoding the pixels. */
  maxPixels: 50_000_000,
  /** A smaller side would look blurred anywhere it is shown. */
  minSide: 320,
  /** Panoramas and slivers are refused. */
  maxAspect: 4,
} as const;

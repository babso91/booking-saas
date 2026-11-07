import "server-only";

import sharp, { type Metadata, type SharpOptions } from "sharp";

import {
  SITE_PHOTO_WIDTHS,
  sitePhotoLimits,
  type SitePhotoType,
  type SitePhotoWidth,
} from "@/features/sites/photos/limits";
import { AppException } from "@/lib/errors";

// Verifies an uploaded photo by DECODING it (its real type, never the one
// declared), then makes the WebP derivatives the proxies serve
// (docs/SITE_PUBLISHING_CONTRACT.md § 8): turned upright from its EXIF
// orientation, converted to sRGB, every metadata dropped (EXIF, GPS, XMP,
// ICC, comments). The original is never served and is deleted once the
// derivatives exist.

export type ProcessedSitePhoto = {
  /** The real type, found by decoding. */
  contentType: SitePhotoType;
  /** Upright dimensions. */
  width: number;
  height: number;
  derivatives: { width: SitePhotoWidth; data: Buffer }[];
};

function unsupported(message: string): never {
  throw new AppException("site_photo_unsupported", { message });
}

/** The real type of a decoded file; refuses anything else (HEIC included). */
export function realType(
  metadata: Pick<Metadata, "format" | "compression">,
): SitePhotoType {
  switch (metadata.format) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "heif":
      // AVIF is HEIF with AV1. HEIC (HEVC) is not decodable here.
      if (metadata.compression === "av1") return "image/avif";
      return unsupported(
        "Les photos HEIC ne sont pas acceptées. Choisissez-la depuis la photothèque : l’iPhone l’enverra en JPEG.",
      );
    default:
      return unsupported(
        "Ce fichier n’est pas une photo JPEG, PNG, WebP ou AVIF.",
      );
  }
}

/**
 * Decodes, checks and converts an uploaded photo. Throws
 * `site_photo_unsupported` (not a photo, or not one of the accepted types),
 * `site_photo_too_large` or `site_photo_invalid` (dimensions).
 */
export async function processSitePhoto(
  input: Buffer,
): Promise<ProcessedSitePhoto> {
  if (input.byteLength === 0) unsupported("Le fichier est vide.");
  if (input.byteLength > sitePhotoLimits.maxBytes) {
    throw new AppException("site_photo_too_large");
  }

  const options: SharpOptions = {
    limitInputPixels: sitePhotoLimits.maxPixels,
    failOn: "error",
    // The first frame only (an animated WebP/PNG becomes a still).
    pages: 1,
  };

  let metadata: Metadata;
  try {
    // The header only: no pixel is decoded, so the pixel limit is checked
    // below with its own error.
    metadata = await sharp(input, { pages: 1 }).metadata();
  } catch (cause) {
    throw new AppException("site_photo_unsupported", {
      message: "Ce fichier n’est pas une photo lisible.",
      cause,
    });
  }
  const contentType = realType(metadata);

  if (!metadata.width || !metadata.height) {
    unsupported("Ce fichier n’est pas une photo lisible.");
  }
  if (metadata.width * metadata.height > sitePhotoLimits.maxPixels) {
    throw new AppException("site_photo_too_large");
  }
  // Orientations 5 to 8 turn the photo a quarter: its sides swap.
  const turned = (metadata.orientation ?? 1) >= 5;
  const width = turned ? metadata.height : metadata.width;
  const height = turned ? metadata.width : metadata.height;
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (
    Math.min(width, height) < sitePhotoLimits.minSide ||
    ratio > sitePhotoLimits.maxAspect
  ) {
    throw new AppException("site_photo_invalid");
  }

  try {
    const upright = sharp(input, options).rotate().toColorspace("srgb");
    const derivatives = await Promise.all(
      SITE_PHOTO_WIDTHS.map(async (target) => ({
        width: target,
        data: await upright
          .clone()
          .resize({ width: target, withoutEnlargement: true })
          // No withMetadata(): sharp writes no EXIF, XMP, ICC or comment.
          .webp({ quality: 80, effort: 4, smartSubsample: true })
          .toBuffer(),
      })),
    );
    return { contentType, width, height, derivatives };
  } catch (cause) {
    throw new AppException("site_photo_unsupported", {
      message: "Ce fichier n’est pas une photo lisible.",
      cause,
    });
  }
}

import { z } from "zod";

import { siteConfigSchema } from "@/features/sites/config";
import {
  SITE_PHOTO_UPLOAD_TYPES,
  SITE_PHOTO_WIDTHS,
  sitePhotoLimits,
} from "@/features/sites/photos/limits";

const revision = z.number().int().min(0).max(2_147_483_647);

export const saveSiteDraftSchema = z.object({
  /** The revision she read (0: no draft yet). */
  expectedRevision: revision,
  config: siteConfigSchema,
});

export const publishSiteSchema = z.object({
  expectedRevision: revision.min(1),
});

export const siteVersionSchema = z.object({ versionId: z.uuid() });

export const restoreSiteVersionSchema = z.object({
  versionId: z.uuid(),
  expectedRevision: revision,
});

export const createSitePhotoUploadSchema = z.object({
  /** As the browser declares it; the server decodes the real one. */
  contentType: z.enum(SITE_PHOTO_UPLOAD_TYPES),
  byteSize: z.number().int().min(1).max(sitePhotoLimits.maxBytes),
});

export const sitePhotoSchema = z.object({ assetId: z.uuid() });

/** The proxies' path parameters. */
export const sitePhotoRequestSchema = z.object({
  assetId: z.uuid(),
  width: z
    .enum(SITE_PHOTO_WIDTHS.map(String) as ["480", "828", "1200"])
    .transform((value) => Number(value) as (typeof SITE_PHOTO_WIDTHS)[number]),
});

import { z } from "zod";

import { siteConfigSchema } from "@/features/sites/config";

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

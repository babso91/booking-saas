"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  runBusinessAction,
  type BusinessActionContext,
} from "@/features/businesses/actions/run-business-action";
import {
  confirmSitePhoto,
  createSitePhotoUpload,
  deleteSitePhoto,
  revokeSitePhoto,
} from "@/features/sites/data/photos";
import {
  getSite,
  getSiteVersion,
  listSiteVersions,
  publishSite,
  restoreSiteVersion,
  saveSiteDraft,
  type SiteWriter,
} from "@/features/sites/data/sites";
import {
  createSitePhotoUploadSchema,
  publishSiteSchema,
  restoreSiteVersionSchema,
  saveSiteDraftSchema,
  sitePhotoSchema,
  siteVersionSchema,
} from "@/features/sites/schemas";
import { AppException } from "@/lib/errors";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Her studio's calls to the site contract (docs/SITE_PUBLISHING_CONTRACT.md
// § 6, § 8), each bound to the business the studio was opened for. The
// session decides the business on every call: a studio left open while the
// session moved to another business (another account signed in in another
// tab) would otherwise send its late save, publication or photo to that
// other business whenever the revisions happen to match. The server
// compares the two and refuses (`site_business_changed`), before any read
// or write. The site contract's own actions are unchanged.

const origin = z.object({ businessId: z.uuid() });

function bound<Shape extends z.ZodRawShape, T>(
  schema: z.ZodObject<Shape>,
  input: unknown,
  handler: (
    context: BusinessActionContext,
    data: z.output<z.ZodObject<Shape>>,
  ) => Promise<T>,
) {
  return runBusinessAction(
    schema.extend(origin.shape),
    input,
    (context, data) => {
      if ((data as { businessId: string }).businessId !== context.businessId)
        throw new AppException("site_business_changed");
      return handler(context, data as z.output<z.ZodObject<Shape>>);
    },
  );
}

function writer({ businessId, userId }: BusinessActionContext): SiteWriter {
  return {
    service: createAdminSupabaseClient() as AppSupabaseClient,
    businessId,
    actor: userId,
  };
}

const none = z.object({});

export async function studioReadSiteAction(input: unknown) {
  return bound(none, input, ({ client, businessId }) =>
    getSite(client, businessId),
  );
}

export async function studioSaveDraftAction(input: unknown) {
  return bound(saveSiteDraftSchema, input, (context, data) =>
    saveSiteDraft(writer(context), {
      expectedRevision: data.expectedRevision,
      config: data.config,
    }),
  );
}

export async function studioPublishAction(input: unknown) {
  const result = await bound(publishSiteSchema, input, (context, data) =>
    publishSite(writer(context), data.expectedRevision),
  );
  if (result.ok) revalidatePath("/b/[slug]", "page");
  return result;
}

export async function studioListVersionsAction(input: unknown) {
  return bound(none, input, ({ client, businessId }) =>
    listSiteVersions(client, businessId),
  );
}

export async function studioGetVersionAction(input: unknown) {
  return bound(siteVersionSchema, input, ({ client, businessId }, data) =>
    getSiteVersion(client, businessId, data.versionId),
  );
}

export async function studioRestoreVersionAction(input: unknown) {
  return bound(restoreSiteVersionSchema, input, (context, data) =>
    restoreSiteVersion(writer(context), {
      versionId: data.versionId,
      expectedRevision: data.expectedRevision,
    }),
  );
}

export async function studioCreatePhotoUploadAction(input: unknown) {
  return bound(createSitePhotoUploadSchema, input, (context, data) =>
    createSitePhotoUpload(writer(context), {
      contentType: data.contentType,
      byteSize: data.byteSize,
    }),
  );
}

export async function studioConfirmPhotoAction(input: unknown) {
  return bound(sitePhotoSchema, input, (context, data) =>
    confirmSitePhoto(writer(context), data.assetId),
  );
}

/** Deletes a photo nothing refers to (`site_asset_in_use` otherwise). */
export async function studioDeletePhotoAction(input: unknown) {
  return bound(sitePhotoSchema, input, (context, data) =>
    deleteSitePhoto(writer(context), data.assetId),
  );
}

/** Revokes a photo for good, wherever it is used, published included. */
export async function studioRevokePhotoAction(input: unknown) {
  const result = await bound(sitePhotoSchema, input, (context, data) =>
    revokeSitePhoto(writer(context), data.assetId),
  );
  if (result.ok) revalidatePath("/b/[slug]", "page");
  return result;
}

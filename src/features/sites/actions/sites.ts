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
  listSitePhotos,
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
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Her mini-site (docs/SITE_PUBLISHING_CONTRACT.md § 6). The business and the
// acting member are always the session's; writes use the service client
// only after validation, and the database checks her membership again.

function writer({ businessId, userId }: BusinessActionContext): SiteWriter {
  return {
    service: createAdminSupabaseClient() as AppSupabaseClient,
    businessId,
    actor: userId,
  };
}

/** Her draft, its revision, her plan and her published version; null: none. */
export async function getSiteAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    getSite(client, businessId),
  );
}

/** Saves the draft at `expectedRevision` (`stale_site_draft` otherwise). */
export async function saveSiteDraftAction(input: unknown) {
  return runBusinessAction(saveSiteDraftSchema, input, (context, data) =>
    saveSiteDraft(writer(context), data),
  );
}

/** Publishes the draft at `expectedRevision`, readable, as a new version. */
export async function publishSiteAction(input: unknown) {
  const result = await runBusinessAction(
    publishSiteSchema,
    input,
    (context, data) => publishSite(writer(context), data.expectedRevision),
  );
  if (result.ok) revalidatePath("/b/[slug]", "page");
  return result;
}

/** Her published versions, the latest first. */
export async function listSiteVersionsAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    listSiteVersions(client, businessId),
  );
}

export async function getSiteVersionAction(input: unknown) {
  return runBusinessAction(
    siteVersionSchema,
    input,
    ({ client, businessId }, data) =>
      getSiteVersion(client, businessId, data.versionId),
  );
}

/** Copies a published version into the draft (history untouched). */
export async function restoreSiteVersionAction(input: unknown) {
  return runBusinessAction(restoreSiteVersionSchema, input, (context, data) =>
    restoreSiteVersion(writer(context), data),
  );
}

// Her photos (contract § 8).

/**
 * A pending photo and a signed URL to send its original to (browser:
 * `storage.from("site-photos").uploadToSignedUrl(path, token, file)`), then
 * confirmSitePhotoAction.
 */
export async function createSitePhotoUploadAction(input: unknown) {
  return runBusinessAction(
    createSitePhotoUploadSchema,
    input,
    (context, data) => createSitePhotoUpload(writer(context), data),
  );
}

/** Verifies and converts the original sent; the photo is then ready. */
export async function confirmSitePhotoAction(input: unknown) {
  return runBusinessAction(sitePhotoSchema, input, (context, data) =>
    confirmSitePhoto(writer(context), data.assetId),
  );
}

/** Her photos, the latest first (pending, ready, revoked). */
export async function listSitePhotosAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    listSitePhotos(client, businessId),
  );
}

/** Deletes a photo nothing refers to (`site_asset_in_use` otherwise). */
export async function deleteSitePhotoAction(input: unknown) {
  return runBusinessAction(sitePhotoSchema, input, (context, data) =>
    deleteSitePhoto(writer(context), data.assetId),
  );
}

/** Revokes a photo for good, wherever it is used, and deletes its files. */
export async function revokeSitePhotoAction(input: unknown) {
  const result = await runBusinessAction(
    sitePhotoSchema,
    input,
    (context, data) => revokeSitePhoto(writer(context), data.assetId),
  );
  if (result.ok) revalidatePath("/b/[slug]", "page");
  return result;
}

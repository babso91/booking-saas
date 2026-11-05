import "server-only";

import type { SiteWriter } from "@/features/sites/data/sites";
import {
  SITE_PHOTO_WIDTHS,
  type SitePhotoType,
  type SitePhotoWidth,
} from "@/features/sites/photos/limits";
import { processSitePhoto } from "@/features/sites/photos/process";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Her mini-site's photos (docs/SITE_PUBLISHING_CONTRACT.md § 8). The bucket
// is private and no storage policy is granted to the API roles: the browser
// sends its original with a signed upload URL issued here for her business,
// and only the service reads or deletes files. The database decides what
// may be served (published, ready, hers); the files follow its decisions.

export const SITE_PHOTO_BUCKET = "site-photos";

/** Every file one photo may have: its original, then its derivatives. */
export function sitePhotoFiles(businessId: string, assetId: string) {
  return [
    `${businessId}/${assetId}/original`,
    ...SITE_PHOTO_WIDTHS.map((width) =>
      derivativePath(businessId, assetId, width),
    ),
  ];
}

function originalPath(businessId: string, assetId: string) {
  return `${businessId}/${assetId}/original`;
}

function derivativePath(
  businessId: string,
  assetId: string,
  width: SitePhotoWidth,
) {
  return `${businessId}/${assetId}/w${width}.webp`;
}

function storageException(cause: unknown): AppException {
  return new AppException("internal", { cause });
}

/**
 * What a purge deletes: the original only (a photo made ready), or every
 * file of the photo (revoked, deleted, discarded).
 */
export type SitePhotoPurgeScope = "original" | "all";

/**
 * Runs a purge the database recorded with its decision: deletes the files,
 * then marks it done. Throws `site_photo_cleanup_pending` when the files
 * could not be deleted: the purge stays recorded (attempt counted) and is
 * retried, by the same action again or by processSitePhotoPurges.
 */
async function purgeFiles(
  service: AppSupabaseClient,
  businessId: string,
  assetId: string,
  scope: SitePhotoPurgeScope,
) {
  const { error } = await service.storage
    .from(SITE_PHOTO_BUCKET)
    .remove(
      scope === "original"
        ? [originalPath(businessId, assetId)]
        : sitePhotoFiles(businessId, assetId),
    );
  if (error) {
    const { error: countError } = await service.rpc("fail_site_photo_purge", {
      p_business_id: businessId,
      p_asset_id: assetId,
      p_scope: scope,
    });
    if (countError)
      console.error("Site photo purge count failed", countError.code);
    throw new AppException("site_photo_cleanup_pending", { cause: error });
  }
  const { error: doneError } = await service.rpc("complete_site_photo_purge", {
    p_business_id: businessId,
    p_asset_id: assetId,
    p_scope: scope,
  });
  if (doneError) {
    throw new AppException("site_photo_cleanup_pending", { cause: doneError });
  }
}

/**
 * Retries the purges left by a failed or interrupted removal (requested
 * before `before`, so that removals still in flight are left to their
 * action), the oldest first. For the periodic cleanup.
 */
export async function processSitePhotoPurges(
  service: AppSupabaseClient,
  options: { before: Date; limit: number },
): Promise<{ done: number; failed: number }> {
  const { data, error } = await service.rpc("pending_site_photo_purges", {
    p_before: options.before.toISOString(),
    p_limit: options.limit,
  });
  if (error) throw databaseException(error);
  let done = 0;
  let failed = 0;
  for (const purge of data) {
    try {
      await purgeFiles(
        service,
        purge.business_id,
        purge.asset_id,
        purge.scope as SitePhotoPurgeScope,
      );
      done += 1;
    } catch (cause) {
      if (!(cause instanceof AppException)) throw cause;
      failed += 1;
    }
  }
  return { done, failed };
}

export type SitePhotoStatus = "pending" | "ready" | "revoked";

export type SitePhotoDto = {
  id: string;
  status: SitePhotoStatus;
  /** The real type, once verified. */
  contentType: SitePhotoType | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  revokedAt: string | null;
};

export type SitePhotoUpload = {
  assetId: string;
  /** Upload the file there with `uploadToSignedUrl(path, token, file)`. */
  path: string;
  token: string;
  signedUrl: string;
};

/**
 * A new pending photo and where to send its original (a signed upload URL,
 * for this path only, valid two hours). Confirm it once sent.
 */
export async function createSitePhotoUpload(
  writer: SiteWriter,
  input: { contentType: SitePhotoType; byteSize: number },
): Promise<SitePhotoUpload> {
  const { data: assetId, error } = await writer.service.rpc(
    "create_site_asset",
    {
      p_business_id: writer.businessId,
      p_actor: writer.actor,
      p_content_type: input.contentType,
      p_byte_size: input.byteSize,
    },
  );
  if (error) throw databaseException(error);

  const path = originalPath(writer.businessId, assetId);
  const { data, error: signError } = await writer.service.storage
    .from(SITE_PHOTO_BUCKET)
    .createSignedUploadUrl(path, { upsert: false });
  if (signError) {
    await discard(writer, assetId);
    throw storageException(signError);
  }
  return { assetId, path, token: data.token, signedUrl: data.signedUrl };
}

async function discard(writer: SiteWriter, assetId: string) {
  const { error } = await writer.service.rpc("discard_site_asset", {
    p_business_id: writer.businessId,
    p_actor: writer.actor,
    p_asset_id: assetId,
  });
  if (error) {
    console.error("Site photo discard failed", error.code);
    return;
  }
  // The purge is recorded with the discard: retried later if this fails.
  await purgeFiles(writer.service, writer.businessId, assetId, "all").catch(
    () => console.error("Site photo files removal failed; purge kept"),
  );
}

async function readAsset(
  service: AppSupabaseClient,
  businessId: string,
  assetId: string,
): Promise<SitePhotoDto | null> {
  const { data, error } = await service
    .from("site_assets")
    .select("id, status, content_type, width, height, created_at, revoked_at")
    .eq("business_id", businessId)
    .eq("id", assetId)
    .maybeSingle();
  if (error) throw databaseException(error);
  return data ? toDto(data) : null;
}

function toDto(row: {
  id: string;
  status: string;
  content_type: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
  revoked_at: string | null;
}): SitePhotoDto {
  return {
    id: row.id,
    status: row.status as SitePhotoStatus,
    contentType: row.content_type as SitePhotoType | null,
    width: row.width,
    height: row.height,
    createdAt: new Date(row.created_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

/**
 * Verifies the original she sent (decoded: its real type, size and
 * dimensions), makes its derivatives, then makes the photo ready and deletes
 * the original. A refused file is forgotten (photo and files). Idempotent
 * once ready. Answers only once the original is gone:
 * `site_photo_cleanup_pending` otherwise (the photo is ready, its original's
 * deletion is recorded; confirming again retries it).
 */
export async function confirmSitePhoto(
  writer: SiteWriter,
  assetId: string,
): Promise<SitePhotoDto> {
  const { service, businessId } = writer;
  // Her membership first: nothing is read for someone else.
  const { error: actorError } = await service.rpc("member_site_photo", {
    p_business_id: businessId,
    p_actor: writer.actor,
    p_asset_id: assetId,
  });
  if (actorError) throw databaseException(actorError);

  const asset = await readAsset(service, businessId, assetId);
  if (!asset) throw new AppException("site_photo_not_found");
  if (asset.status === "ready") {
    // A previous confirmation may have left its original: deleted now (a
    // no-op once gone).
    await purgeFiles(service, businessId, assetId, "original");
    return asset;
  }
  if (asset.status === "revoked") throw new AppException("site_photo_revoked");

  const bucket = service.storage.from(SITE_PHOTO_BUCKET);
  const { data: blob, error: downloadError } = await bucket.download(
    originalPath(businessId, assetId),
  );
  if (downloadError || !blob) {
    // Not sent (yet): she may send it and confirm again.
    throw new AppException("site_photo_not_found", {
      message: "La photo n’a pas encore été reçue.",
    });
  }

  let processed;
  try {
    processed = await processSitePhoto(Buffer.from(await blob.arrayBuffer()));
  } catch (error) {
    await discard(writer, assetId);
    throw error;
  }

  try {
    for (const derivative of processed.derivatives) {
      const { error } = await bucket.upload(
        derivativePath(businessId, assetId, derivative.width),
        derivative.data,
        { contentType: "image/webp", upsert: true, cacheControl: "0" },
      );
      if (error) throw storageException(error);
    }
    const { error } = await service.rpc("confirm_site_asset", {
      p_business_id: businessId,
      p_actor: writer.actor,
      p_asset_id: assetId,
      p_content_type: processed.contentType,
      p_byte_size: blob.size,
      p_width: processed.width,
      p_height: processed.height,
    });
    if (error) throw databaseException(error);
  } catch (error) {
    // Revoked or deleted meanwhile: its purge is recorded, its files go
    // (the derivatives just written included). Otherwise the original
    // stays, she may confirm again.
    const current = await readAsset(service, businessId, assetId).catch(
      () => undefined,
    );
    if (current === null || current?.status === "revoked") {
      await purgeFiles(service, businessId, assetId, "all").catch(() =>
        console.error("Site photo files removal failed; purge kept"),
      );
    }
    throw error;
  }

  // The original (with its metadata) is not kept: its purge was recorded
  // with the confirmation; no success is answered while it remains.
  await purgeFiles(service, businessId, assetId, "original");

  const ready = await readAsset(service, businessId, assetId);
  if (!ready) throw new AppException("site_photo_not_found");
  return ready;
}

/** Her photos (pending, ready and revoked), the latest first. */
export async function listSitePhotos(
  client: AppSupabaseClient,
  businessId: string,
): Promise<SitePhotoDto[]> {
  const { data, error } = await client
    .from("site_assets")
    .select("id, status, content_type, width, height, created_at, revoked_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw databaseException(error);
  return data.map(toDto);
}

/**
 * Deletes a photo nothing refers to, and its files (`site_asset_in_use`
 * otherwise: revoke it). A revoked photo stays revoked. If its files could
 * not be deleted (`site_photo_cleanup_pending`), calling it again retries.
 */
export async function deleteSitePhoto(
  writer: SiteWriter,
  assetId: string,
): Promise<{ deleted: boolean }> {
  const { data, error } = await writer.service.rpc("delete_site_asset", {
    p_business_id: writer.businessId,
    p_actor: writer.actor,
    p_asset_id: assetId,
  });
  if (error) throw databaseException(error);
  await purgeFiles(writer.service, writer.businessId, assetId, "all");
  return { deleted: data === "deleted" };
}

/**
 * Revokes a photo for good, wherever it is used, then deletes its files.
 * From this moment the proxies refuse it; shared caches may keep a copy for
 * up to five minutes (contract § 8). Idempotent: called again, it deletes
 * any file left (`site_photo_cleanup_pending` until they are gone).
 */
export async function revokeSitePhoto(
  writer: SiteWriter,
  assetId: string,
): Promise<void> {
  const { error } = await writer.service.rpc("revoke_site_asset", {
    p_business_id: writer.businessId,
    p_actor: writer.actor,
    p_asset_id: assetId,
  });
  if (error) throw databaseException(error);
  await purgeFiles(writer.service, writer.businessId, assetId, "all");
}

/** The same, for a privacy request handled by the service (no member). */
export async function revokeSitePhotoForPrivacy(
  service: AppSupabaseClient,
  businessId: string,
  assetId: string,
): Promise<void> {
  const { error } = await service.rpc("revoke_site_asset_for_privacy", {
    p_business_id: businessId,
    p_asset_id: assetId,
  });
  if (error) throw databaseException(error);
  await purgeFiles(service, businessId, assetId, "all");
}

async function readDerivative(
  service: AppSupabaseClient,
  businessId: string,
  assetId: string,
  width: SitePhotoWidth,
): Promise<ArrayBuffer | null> {
  const { data, error } = await service.storage
    .from(SITE_PHOTO_BUCKET)
    .download(derivativePath(businessId, assetId, width));
  if (error || !data) return null;
  return data.arrayBuffer();
}

/**
 * For the public proxy: the derivative of a ready photo referred to by the
 * PUBLISHED version of `slug`'s site; null for anything else.
 */
export async function readPublicSitePhoto(
  service: AppSupabaseClient,
  slug: string,
  assetId: string,
  width: SitePhotoWidth,
): Promise<ArrayBuffer | null> {
  const { data: businessId, error } = await service.rpc("public_site_photo", {
    p_slug: slug,
    p_asset_id: assetId,
  });
  if (error) throw databaseException(error);
  if (!businessId) return null;
  return readDerivative(service, businessId, assetId, width);
}

/** For her studio's preview: a ready photo of her business; null otherwise. */
export async function readMemberSitePhoto(
  writer: SiteWriter,
  assetId: string,
  width: SitePhotoWidth,
): Promise<ArrayBuffer | null> {
  const { data: ready, error } = await writer.service.rpc("member_site_photo", {
    p_business_id: writer.businessId,
    p_actor: writer.actor,
    p_asset_id: assetId,
  });
  if (error) throw databaseException(error);
  if (!ready) return null;
  return readDerivative(writer.service, writer.businessId, assetId, width);
}

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

  // Before anything is written: the obligation to delete what this
  // conversion may write, should the photo go meanwhile (settled by the
  // cleanup after its deadline, whatever happens to this process).
  const { error: beginError } = await service.rpc(
    "begin_site_photo_conversion",
    { p_business_id: businessId, p_actor: writer.actor, p_asset_id: assetId },
  );
  if (beginError) throw databaseException(beginError);

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
      await assertStillWritable(service, businessId, assetId);
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
    // stays, she may confirm again. Only a first attempt: if it fails, the
    // conversion's obligation has them deleted after its deadline.
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

/**
 * One more file may be written only while the conversion's deadline is far
 * enough (site_photo_conversion_writable): after it, the cleanup may have
 * settled it, and a file written then would be seen by nobody. `conflict`
 * otherwise: confirming again starts a new conversion.
 */
async function assertStillWritable(
  service: AppSupabaseClient,
  businessId: string,
  assetId: string,
) {
  const { data, error } = await service.rpc("site_photo_conversion_writable", {
    p_business_id: businessId,
    p_asset_id: assetId,
  });
  if (error) throw databaseException(error);
  if (data !== true) {
    throw new AppException("conflict", {
      message: "La conversion a pris trop de temps. Réessayez.",
    });
  }
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

export type SitePhotoReconciliation =
  | { skipped: true }
  | {
      skipped: false;
      /** Objects of the bucket examined by this run. */
      scanned: number;
      /** Objects no photo justifies, seen by this run. */
      suspects: number;
      /** Names outside the photos' layout: counted, never deleted. */
      unknown: number;
      deleted: number;
      failed: number;
      /** This run reached the end of the bucket (a full pass ended). */
      complete: boolean;
    }
  | { skipped: false; error: true };

/**
 * The bucket reconciled with the database (migration, "Reconciliation of
 * the bucket"): reads Storage's index of the bucket by pages, from where
 * the pass stands; the database judges each object against the photos and
 * records the suspects; those suspected for the safety period are deleted
 * through Storage, the outcome recorded. A run holds the pass (another run
 * meanwhile is skipped), resumes where the previous one stopped, and stops
 * after `maxPages` pages. Never deletes on an incomplete answer: a failed
 * page stops the run (`error`) with nothing deleted from it.
 */
export async function reconcileSitePhotoBucket(
  service: AppSupabaseClient,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<SitePhotoReconciliation> {
  const pageSize = options.pageSize ?? 1000;
  const maxPages = options.maxPages ?? 20;
  const run = crypto.randomUUID();
  const { data: cursor, error: claimError } = await service.rpc(
    "claim_site_photo_reconciliation",
    { p_run: run },
  );
  if (claimError) throw databaseException(claimError);
  if (cursor === null) return { skipped: true };

  const totals = {
    scanned: 0,
    suspects: 0,
    unknown: 0,
    deleted: 0,
    failed: 0,
    complete: false,
  };
  try {
    for (let page = 0; page < maxPages && !totals.complete; page += 1) {
      const { data, error } = await service.rpc(
        "site_photo_reconciliation_page",
        { p_run: run, p_limit: pageSize },
      );
      if (error) throw databaseException(error);
      const result = data as {
        scanned: number;
        suspects: number;
        unknown: number;
        due: string[];
        complete: boolean;
      };
      totals.scanned += result.scanned;
      totals.suspects += result.suspects;
      totals.unknown += result.unknown;
      totals.complete = result.complete;
      for (let start = 0; start < result.due.length; start += 100) {
        const batch = result.due.slice(start, start + 100);
        const { data: removed, error: removeError } = await service.storage
          .from(SITE_PHOTO_BUCKET)
          .remove(batch);
        // Only what Storage says it deleted is forgotten; anything else is
        // judged again at the next pass.
        const deleted = removeError
          ? []
          : (removed ?? []).map((object) => object.name);
        const failed = removeError ? batch : [];
        const { error: recordError } = await service.rpc(
          "record_site_photo_orphan_deletions",
          { p_run: run, p_deleted: deleted, p_failed: failed },
        );
        if (recordError) throw databaseException(recordError);
        totals.deleted += deleted.length;
        totals.failed += failed.length;
      }
    }
  } finally {
    const { error } = await service.rpc("release_site_photo_reconciliation", {
      p_run: run,
    });
    if (error)
      console.error("Site photo reconciliation not released", error.code);
  }
  return { skipped: false, ...totals };
}

/**
 * The periodic cleanup (GET /api/cron/site-photos): forgets the uploads
 * abandoned once their upload URL has expired (not while being converted),
 * settles the conversions past their deadline (a photo gone or revoked
 * meanwhile: all its files recorded for deletion again, files a late
 * conversion wrote included), then runs every purge due (left by a failure
 * or an interruption, or done early and due again now that nothing can
 * write any more), and finally reconciles the bucket with the database
 * (reconcileSitePhotoBucket: whatever was written after its obligation was
 * settled). Purges requested in the last minute are left to the action
 * that recorded them. A failed reconciliation does not undo the rest: it
 * answers `reconciliation: { error: true }`.
 */
export async function runSitePhotoMaintenance(
  service: AppSupabaseClient,
  options: {
    limit?: number;
    now?: Date;
    reconciliation?: { pageSize?: number; maxPages?: number };
  } = {},
): Promise<{
  abandoned: number;
  conversions: number;
  done: number;
  failed: number;
  reconciliation: SitePhotoReconciliation;
}> {
  const limit = options.limit ?? 200;
  const { data: abandoned, error } = await service.rpc(
    "discard_abandoned_site_assets",
    { p_limit: limit },
  );
  if (error) throw databaseException(error);
  const { data: conversions, error: conversionsError } = await service.rpc(
    "expire_site_photo_conversions",
    { p_limit: limit },
  );
  if (conversionsError) throw databaseException(conversionsError);
  const now = options.now ?? new Date();
  const purges = await processSitePhotoPurges(service, {
    before: new Date(now.getTime() - 60_000),
    limit,
  });
  let reconciliation: SitePhotoReconciliation;
  try {
    reconciliation = await reconcileSitePhotoBucket(
      service,
      options.reconciliation,
    );
  } catch (cause) {
    console.error("Site photo reconciliation failed", cause);
    reconciliation = { skipped: false, error: true };
  }
  return {
    abandoned: abandoned ?? 0,
    conversions: conversions ?? 0,
    ...purges,
    reconciliation,
  };
}

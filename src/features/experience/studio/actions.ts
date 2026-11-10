"use client";

import { callAction, type UiResult } from "@/features/auth/client/call-action";
import type { SiteConfig as SavedConfig } from "@/features/sites/config";
import type {
  SiteDto,
  SiteVersionDto,
  SiteVersionSummary,
} from "@/features/sites/data/sites";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

import type { PhotoSource } from "../engine/engine";
import {
  studioConfirmPhotoAction,
  studioCreatePhotoUploadAction,
  studioDeletePhotoAction,
  studioGetVersionAction,
  studioListVersionsAction,
  studioPublishAction,
  studioReadSiteAction,
  studioRestoreVersionAction,
  studioRevokePhotoAction,
  studioSaveDraftAction,
} from "./server-actions";

// What her studio asks the server, in one place: the Server Actions of
// docs/SITE_PUBLISHING_CONTRACT.md § 6 and the photo upload of § 8. The
// studio takes them as a whole, so a design preview or a test can give it
// an in-memory server instead (never anything that reaches a real site).

export type UploadType = "image/jpeg" | "image/png" | "image/webp";

export type StudioActions = {
  read: () => Promise<UiResult<SiteDto | null>>;
  save: (
    expectedRevision: number,
    config: SavedConfig,
  ) => Promise<UiResult<{ revision: number }>>;
  publish: (
    expectedRevision: number,
  ) => Promise<
    UiResult<{ versionId: string; number: number; publishedAt: string }>
  >;
  versions: () => Promise<UiResult<SiteVersionSummary[]>>;
  version: (versionId: string) => Promise<UiResult<SiteVersionDto>>;
  restore: (
    versionId: string,
    expectedRevision: number,
  ) => Promise<UiResult<{ revision: number }>>;
  /** Sends a photo: created, uploaded, then verified by the server. */
  upload: (file: File, type: UploadType) => Promise<UiResult<{ id: string }>>;
  /**
   * Out of her library: deleted if nothing uses it (`site_asset_in_use`
   * otherwise), or `forGood`: revoked everywhere, published versions too.
   */
  removePhoto: (id: string, forGood: boolean) => Promise<UiResult<unknown>>;
  /** Where its photos are shown, for a server that keeps them elsewhere. */
  photo?: PhotoSource;
};

/**
 * Her server, for the business her studio was opened for: every call
 * carries it, and the server refuses it if the session's business is
 * another one by then (`site_business_changed`), so nothing of this
 * studio can ever be read from or written to another business.
 */
export const studioActionsFor = (businessId: string): StudioActions => ({
  read: () => callAction(() => studioReadSiteAction({ businessId })),
  save: (expectedRevision, config) =>
    callAction(() =>
      studioSaveDraftAction({ businessId, expectedRevision, config }),
    ),
  publish: (expectedRevision) =>
    callAction(() => studioPublishAction({ businessId, expectedRevision })),
  versions: () => callAction(() => studioListVersionsAction({ businessId })),
  removePhoto: (assetId, forGood) =>
    forGood
      ? callAction(() => studioRevokePhotoAction({ businessId, assetId }))
      : callAction(() => studioDeletePhotoAction({ businessId, assetId })),
  version: (versionId) =>
    callAction(() => studioGetVersionAction({ businessId, versionId })),
  restore: (versionId, expectedRevision) =>
    callAction(() =>
      studioRestoreVersionAction({ businessId, versionId, expectedRevision }),
    ),
  async upload(file, type) {
    const created = await callAction(() =>
      studioCreatePhotoUploadAction({
        businessId,
        contentType: type,
        byteSize: file.size,
      }),
    );
    if (!created.ok) return created;
    const { assetId, path, token } = created.data;
    // The file goes straight to her private bucket. Whatever stops it on
    // the way (the connection, the client itself) is said as a failure to
    // send: she can try again, never left waiting.
    try {
      const sent = await createBrowserSupabaseClient()
        .storage.from("site-photos")
        .uploadToSignedUrl(path, token, file, { contentType: type });
      if (sent.error) return { ok: false, error: { code: "network" } };
    } catch {
      return { ok: false, error: { code: "network" } };
    }
    const confirmed = await callAction(() =>
      studioConfirmPhotoAction({ businessId, assetId }),
    );
    return confirmed.ok ? { ok: true, data: { id: assetId } } : confirmed;
  },
});

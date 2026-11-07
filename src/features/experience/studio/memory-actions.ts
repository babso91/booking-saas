"use client";

import type { UiErrorCode, UiResult } from "@/features/auth/client/call-action";
import {
  siteConfigSchema,
  type SiteConfig as SavedConfig,
} from "@/features/sites/config";
import type {
  SiteDto,
  SitePlan,
  SiteVersionDto,
} from "@/features/sites/data/sites";

import type { StudioActions } from "./actions";
import { studioPhoto } from "./photos";

// An in-memory server with the contract's behaviour (revisions,
// `stale_site_draft`, immutable versions, restore into the draft, the
// schema's validation), for the studio's design preview and its tests
// only: nothing here reaches a database, a bucket or a public page.

export type MemoryOptions = {
  plan: SitePlan;
  /** Her site as it starts (null: nothing saved yet). */
  start?: SavedConfig | null;
  /** Publishes `start` first, as version 1. */
  published?: boolean;
  /** Another tab saves once, right before her first save. */
  conflict?: boolean;
  /** Every photo upload fails with this code. */
  photoError?: UiErrorCode;
};

const fail = (code: UiErrorCode) => ({ ok: false as const, error: { code } });
const pause = () => new Promise((resolve) => setTimeout(resolve, 120));

export function memoryStudioActions(options: MemoryOptions): StudioActions & {
  /** What the server holds now, to check what was really saved. */
  peek: () => { revision: number; config: SavedConfig | null };
} {
  let revision = options.start ? 1 : 0;
  let config: SavedConfig | null = options.start ?? null;
  let restoredFrom: string | null = null;
  let conflictPending = Boolean(options.conflict);
  const versions: SiteVersionDto[] = [];
  const photos = new Map<string, string>();

  const publishNow = (): SiteVersionDto => {
    const version: SiteVersionDto = {
      id: `v${versions.length + 1}`,
      number: versions.length + 1,
      publishedAt: new Date().toISOString(),
      restoredFrom,
      current: true,
      schemaVersion: 1,
      config: structuredClone(config!),
    };
    for (const old of versions) old.current = false;
    versions.unshift(version);
    return version;
  };
  if (options.published && config) publishNow();

  const dto = (): SiteDto => ({
    plan: options.plan,
    revision,
    schemaVersion: config ? 1 : null,
    config: config ? structuredClone(config) : null,
    restoredFrom,
    updatedAt: config ? new Date().toISOString() : null,
    published: versions[0]
      ? {
          versionId: versions[0].id,
          number: versions[0].number,
          publishedAt: versions[0].publishedAt,
        }
      : null,
  });

  return {
    peek: () => ({ revision, config }),
    async read(): Promise<UiResult<SiteDto | null>> {
      await pause();
      return { ok: true, data: revision ? dto() : null };
    },
    async save(expectedRevision, next) {
      await pause();
      if (conflictPending && config) {
        // Another tab renamed her business meanwhile.
        conflictPending = false;
        config = {
          ...config,
          brand: {
            ...config.brand,
            intro: "Texte modifié dans un autre onglet.",
          },
        };
        revision += 1;
      }
      if (expectedRevision !== revision) return fail("stale_site_draft");
      const parsed = siteConfigSchema.safeParse(next);
      if (!parsed.success) return fail("validation_error");
      config = parsed.data;
      restoredFrom = null;
      revision += 1;
      return { ok: true, data: { revision } };
    },
    async publish(expectedRevision) {
      await pause();
      if (expectedRevision < 1 || !config) return fail("validation_error");
      if (expectedRevision !== revision) return fail("stale_site_draft");
      const version = publishNow();
      return {
        ok: true,
        data: {
          versionId: version.id,
          number: version.number,
          publishedAt: version.publishedAt,
        },
      };
    },
    async versions() {
      await pause();
      return {
        ok: true,
        data: versions.map((version) => ({
          id: version.id,
          number: version.number,
          publishedAt: version.publishedAt,
          restoredFrom: version.restoredFrom,
          current: version.current,
        })),
      };
    },
    async version(versionId) {
      await pause();
      const found = versions.find((version) => version.id === versionId);
      return found
        ? { ok: true, data: structuredClone(found) }
        : fail("not_found");
    },
    async restore(versionId, expectedRevision) {
      await pause();
      const found = versions.find((version) => version.id === versionId);
      if (!found) return fail("not_found");
      if (expectedRevision !== revision) return fail("stale_site_draft");
      config = structuredClone(found.config);
      restoredFrom = found.id;
      revision += 1;
      return { ok: true, data: { revision } };
    },
    async upload(file) {
      await pause();
      if (options.photoError) return fail(options.photoError);
      const id = crypto.randomUUID();
      photos.set(id, URL.createObjectURL(file));
      return { ok: true, data: { id } };
    },
    photo: (id, width) => photos.get(id) ?? studioPhoto(id, width),
  };
}

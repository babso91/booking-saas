import "server-only";

import {
  SITE_SCHEMA_VERSION,
  siteConfigSchema,
  type SiteConfig,
} from "@/features/sites/config";
import { readabilityIssues } from "@/features/sites/readability";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Her mini-site (docs/SITE_PUBLISHING_CONTRACT.md). Reads under RLS with
// her session; writes with the service client, for the acting member, only
// after the configuration is validated here (schema, registry, texts,
// colours; readability before publishing). The database checks her
// membership, her photos, the revision and keeps the history immutable.

export type SitePlan = "core" | "signature";

export type SiteDto = {
  plan: SitePlan;
  /** Pass it back as `expectedRevision`; 0: no draft yet. */
  revision: number;
  schemaVersion: number | null;
  /** The draft (null before the first save). */
  config: SiteConfig | null;
  /** The version this draft was restored from, until she changes it. */
  restoredFrom: string | null;
  updatedAt: string | null;
  published: { versionId: string; number: number; publishedAt: string } | null;
};

export type SiteVersionSummary = {
  id: string;
  number: number;
  publishedAt: string;
  restoredFrom: string | null;
  /** The one the public sees. */
  current: boolean;
};

export type SiteVersionDto = SiteVersionSummary & {
  schemaVersion: number;
  config: SiteConfig;
};

export type SiteWriter = {
  /** The service client (writes are executable by the service only). */
  service: AppSupabaseClient;
  businessId: string;
  /** The acting member: the session's user. */
  actor: string;
};

const iso = (value: string) => new Date(value).toISOString();

/** Her site, or null before anything was saved or her plan was set. */
export async function getSite(
  client: AppSupabaseClient,
  businessId: string,
): Promise<SiteDto | null> {
  const { data, error } = await client
    .from("sites")
    .select(
      "plan, draft_revision, draft_schema_version, draft_config, draft_restored_from, draft_updated_at, published_version_id, site_versions!sites_published_version_fkey(id, number, published_at)",
    )
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw databaseException(error);
  if (!data) return null;
  const published = data.site_versions as unknown as {
    id: string;
    number: number;
    published_at: string;
  } | null;
  return {
    plan: data.plan as SitePlan,
    revision: data.draft_revision,
    schemaVersion: data.draft_schema_version,
    config: data.draft_config as SiteConfig | null,
    restoredFrom: data.draft_restored_from,
    updatedAt: data.draft_updated_at ? iso(data.draft_updated_at) : null,
    published: published
      ? {
          versionId: published.id,
          number: published.number,
          publishedAt: iso(published.published_at),
        }
      : null,
  };
}

/** Her published versions, the latest first. */
export async function listSiteVersions(
  client: AppSupabaseClient,
  businessId: string,
): Promise<SiteVersionSummary[]> {
  const [site, versions] = await Promise.all([
    client
      .from("sites")
      .select("published_version_id")
      .eq("business_id", businessId)
      .maybeSingle(),
    client
      .from("site_versions")
      .select("id, number, published_at, restored_from")
      .eq("business_id", businessId)
      .order("number", { ascending: false }),
  ]);
  if (site.error) throw databaseException(site.error);
  if (versions.error) throw databaseException(versions.error);
  return versions.data.map((version) => ({
    id: version.id,
    number: version.number,
    publishedAt: iso(version.published_at),
    restoredFrom: version.restored_from,
    current: version.id === site.data?.published_version_id,
  }));
}

export async function getSiteVersion(
  client: AppSupabaseClient,
  businessId: string,
  versionId: string,
): Promise<SiteVersionDto> {
  const [site, version] = await Promise.all([
    client
      .from("sites")
      .select("published_version_id")
      .eq("business_id", businessId)
      .maybeSingle(),
    client
      .from("site_versions")
      .select("id, number, published_at, restored_from, schema_version, config")
      .eq("business_id", businessId)
      .eq("id", versionId)
      .maybeSingle(),
  ]);
  if (site.error) throw databaseException(site.error);
  if (version.error) throw databaseException(version.error);
  if (!version.data) throw new AppException("site_version_not_found");
  return {
    id: version.data.id,
    number: version.data.number,
    publishedAt: iso(version.data.published_at),
    restoredFrom: version.data.restored_from,
    current: version.data.id === site.data?.published_version_id,
    schemaVersion: version.data.schema_version,
    config: version.data.config as SiteConfig,
  };
}

/**
 * Saves her draft (validated by the caller with siteConfigSchema) if it is
 * still at `expectedRevision` (0: the first save). Answers the new revision.
 */
export async function saveSiteDraft(
  writer: SiteWriter,
  input: { expectedRevision: number; config: SiteConfig },
): Promise<{ revision: number }> {
  const { data, error } = await writer.service.rpc("save_site_draft", {
    p_business_id: writer.businessId,
    p_actor: writer.actor,
    p_expected_revision: input.expectedRevision,
    p_schema_version: SITE_SCHEMA_VERSION,
    p_config: input.config,
  });
  if (error) throw databaseException(error);
  return { revision: data };
}

/**
 * Publishes her draft at `expectedRevision`: validated again, readable,
 * then one atomic version. The database publishes that revision only, so
 * what was checked here is exactly what is published.
 */
export async function publishSite(
  writer: SiteWriter,
  expectedRevision: number,
): Promise<{
  versionId: string;
  number: number;
  publishedAt: string;
  created: boolean;
}> {
  const { data: site, error: readError } = await writer.service
    .from("sites")
    .select("draft_revision, draft_config")
    .eq("business_id", writer.businessId)
    .maybeSingle();
  if (readError) throw databaseException(readError);
  if (!site || site.draft_revision === 0)
    throw new AppException("site_not_found");
  if (site.draft_revision !== expectedRevision) {
    throw new AppException("stale_site_draft");
  }

  const parsed = siteConfigSchema.safeParse(site.draft_config);
  if (!parsed.success) {
    throw new AppException("validation_error", { cause: parsed.error });
  }
  const issues = readabilityIssues(parsed.data);
  if (issues.length > 0) {
    throw new AppException("site_unreadable", {
      fieldErrors: {
        palette: issues.map(
          (issue) => `${issue.where} : ${issue.ratio}:1 (4,5:1 au moins).`,
        ),
      },
    });
  }

  const { data, error } = await writer.service
    .rpc("publish_site", {
      p_business_id: writer.businessId,
      p_actor: writer.actor,
      p_expected_revision: expectedRevision,
    })
    .single();
  if (error) throw databaseException(error);
  return {
    versionId: data.version_id,
    number: data.number,
    publishedAt: iso(data.published_at),
    created: data.created,
  };
}

/** Copies a published version into her draft; answers the new revision. */
export async function restoreSiteVersion(
  writer: SiteWriter,
  input: { versionId: string; expectedRevision: number },
): Promise<{ revision: number }> {
  const { data, error } = await writer.service.rpc("restore_site_version", {
    p_business_id: writer.businessId,
    p_actor: writer.actor,
    p_version_id: input.versionId,
    p_expected_revision: input.expectedRevision,
  });
  if (error) throw databaseException(error);
  return { revision: data };
}

export type PublishedSiteDto = {
  versionId: string;
  number: number;
  publishedAt: string;
  /** Her CURRENT plan: the renderer applies its rights to `config`. */
  plan: SitePlan;
  schemaVersion: number;
  config: SiteConfig;
};

/** The published version of a business's site, for the public. */
export async function getPublishedSite(
  client: AppSupabaseClient,
  slug: string,
): Promise<PublishedSiteDto> {
  const { data, error } = await client
    .rpc("get_public_site", { p_slug: slug })
    .single();
  if (error) throw databaseException(error);
  return {
    versionId: data.version_id,
    number: data.number,
    publishedAt: iso(data.published_at),
    plan: data.plan as SitePlan,
    schemaVersion: data.schema_version,
    config: data.config as SiteConfig,
  };
}

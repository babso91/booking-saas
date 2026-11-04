"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  runBusinessAction,
  type BusinessActionContext,
} from "@/features/businesses/actions/run-business-action";
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
  publishSiteSchema,
  restoreSiteVersionSchema,
  saveSiteDraftSchema,
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

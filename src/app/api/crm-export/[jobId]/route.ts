import type { NextRequest } from "next/server";
import { z } from "zod";

import { getBusinessContext } from "@/features/businesses/data/business-context";
import { exportCsv, exportFileName } from "@/features/crm/export/csv";
import { readExportRows } from "@/features/crm/export/data";
import { AppException } from "@/lib/errors";
import { jsonError } from "@/lib/http";
import { databaseException } from "@/lib/supabase/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// GET /api/crm-export/:jobId — her client file, as a CSV, built now from
// her own session (points 146 and 182, docs/CRM_EXPORT_CONTRACT.md). Her
// role and the export are checked again by the database, the download is
// counted; nothing is stored, nothing is cached.
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/crm-export/[jobId]">,
) {
  try {
    const jobId = z.uuid().safeParse((await ctx.params).jobId);
    if (!jobId.success) throw new AppException("not_found");
    const client = await createServerSupabaseClient();
    const { businessId, timezone } = await getBusinessContext(client);
    const file = await readExportRows(client, businessId, jobId.data);
    const { data: business, error } = await client
      .from("businesses")
      .select("slug")
      .eq("id", businessId)
      .single();
    if (error) throw databaseException(error);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
    }).format(new Date());

    return new Response(exportCsv(file), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${exportFileName(file.scope, business.slug, today)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    // Signed out, not the owner, expired, withdrawn: JSON, never stored.
    return jsonError(
      error instanceof AppException
        ? error
        : new AppException("internal", { cause: error }),
    );
  }
}

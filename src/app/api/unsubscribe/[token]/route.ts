import type { NextRequest } from "next/server";

import { unsubscribe } from "@/features/marketing-consent/data";
import { unsubscribeTokenSchema } from "@/features/marketing-consent/schemas";
import { AppException } from "@/lib/errors";
import { jsonError, jsonOk } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// POST /api/unsubscribe/:token — one-click unsubscribe (RFC 8058): the URL
// of the `List-Unsubscribe` header of a marketing email, posted by her mail
// client with `List-Unsubscribe=One-Click`. Withdraws like the page's
// button; idempotent. No GET: opening a link never unsubscribes.
// 200 { alreadyWithdrawn: true }; 404 unsubscribe_link_invalid.
export async function POST(
  _request: NextRequest,
  ctx: RouteContext<"/api/unsubscribe/[token]">,
) {
  try {
    const token = unsubscribeTokenSchema.safeParse((await ctx.params).token);
    if (!token.success) throw new AppException("unsubscribe_link_invalid");
    const view = await unsubscribe(
      createAdminSupabaseClient() as AppSupabaseClient,
      "unsubscribe_withdraw",
      token.data,
    );
    return jsonOk({ alreadyWithdrawn: view.alreadyWithdrawn });
  } catch (error) {
    return jsonError(error);
  }
}

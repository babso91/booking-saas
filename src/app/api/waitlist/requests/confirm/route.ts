import { confirmRequest } from "@/features/waitlist-server/data";
import { confirmSchema } from "@/features/waitlist-server/schemas";
import { validationException } from "@/lib/errors";
import { jsonError, jsonOk, readJsonBody } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// POST /api/waitlist/requests/confirm { token } — the token comes from the
// fragment of the confirmation link, read by the page. Idempotent.
export async function POST(request: Request) {
  try {
    const parsed = confirmSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw validationException(parsed.error);
    return jsonOk(
      await confirmRequest(
        createAdminSupabaseClient() as AppSupabaseClient,
        parsed.data.token,
      ),
    );
  } catch (error) {
    return jsonError(error);
  }
}

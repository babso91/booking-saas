import { endSession } from "@/features/client-hub/data/client-hub";
import {
  clearedSessionCookie,
  sessionTokenOf,
} from "@/features/client-hub/data/session";
import { assertSameOrigin } from "@/features/client-hub/data/route";
import { endSessionSchema } from "@/features/client-hub/schemas/client-hub";
import { validationException } from "@/lib/errors";
import { jsonError, jsonOk } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// DELETE /api/client-hub/session[?all=true] — ends this session (or every
// session of the account) and removes the cookie. Always 200, also without
// a session.
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request, false);
    const parsed = endSessionSchema.safeParse({
      all: new URL(request.url).searchParams.get("all") === "true",
    });
    if (!parsed.success) throw validationException(parsed.error);

    const token = sessionTokenOf(request);
    if (token) {
      await endSession(
        createAdminSupabaseClient() as AppSupabaseClient,
        token,
        parsed.data.all,
      );
    }
    const response = jsonOk({ ended: true });
    response.headers.append("Set-Cookie", clearedSessionCookie());
    return response;
  } catch (error) {
    return jsonError(error);
  }
}

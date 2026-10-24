import { signOut } from "@/features/client-hub/data/client-hub";
import {
  appendCleared,
  presentedSessions,
} from "@/features/client-hub/data/session";
import { assertSameOrigin } from "@/features/client-hub/data/route";
import { endSessionSchema } from "@/features/client-hub/schemas/client-hub";
import { validationException } from "@/lib/errors";
import { jsonError, jsonOk } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// DELETE /api/client-hub/session[?all=true] — ends the sessions the browser
// presents (or every session of their accounts) and deletes their cookies,
// and only theirs: a session opened after this request left has another
// cookie, which this answer cannot touch. Always 200, also without a
// session. More session cookies than the browser may hold: none is ended
// (none is used either), they are only deleted.
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request, false);
    const parsed = endSessionSchema.safeParse({
      all: new URL(request.url).searchParams.get("all") === "true",
    });
    if (!parsed.success) throw validationException(parsed.error);

    const presented = presentedSessions(request);
    if (presented.sessions.length > 0) {
      await signOut(
        createAdminSupabaseClient() as AppSupabaseClient,
        presented,
        parsed.data.all,
      );
    }
    return appendCleared(jsonOk({ ended: true }), presented.names);
  } catch (error) {
    return jsonError(error);
  }
}

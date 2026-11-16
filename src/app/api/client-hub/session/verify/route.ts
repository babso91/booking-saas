import { signIn } from "@/features/client-hub/data/client-hub";
import {
  ACCOUNT_HEADER,
  appendCleared,
  presentedSessions,
  sessionCookie,
} from "@/features/client-hub/data/session";
import { verifyCodeSchema } from "@/features/client-hub/schemas/client-hub";
import { assertSameOrigin } from "@/features/client-hub/data/route";
import { trustedClientIp } from "@/lib/client-identity";
import { AppException, validationException } from "@/lib/errors";
import { jsonError, jsonOk, readJsonBody } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// POST /api/client-hub/session/verify — body { challengeId, email, code }.
// 200 { email, expiresAt }, the new session's own cookie, and the deletion
// of the cookies the browser presented (those sessions are ended: signing
// in replaces who the browser is); 400 client_hub_code_invalid for a wrong,
// expired, used or exhausted code (one answer for all), which changes no
// cookie; 429 rate_limited.
export async function POST(request: Request) {
  try {
    assertSameOrigin(request, true);
    let clientIp: string;
    try {
      clientIp = trustedClientIp(request);
    } catch {
      throw new AppException("client_hub_unavailable");
    }
    const parsed = verifyCodeSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw validationException(parsed.error);

    const presented = presentedSessions(request);
    const session = await signIn(
      createAdminSupabaseClient() as AppSupabaseClient,
      parsed.data,
      clientIp,
      presented,
    );

    const response = jsonOk({
      email: session.email,
      expiresAt: session.expiresAt,
    });
    response.headers.set(ACCOUNT_HEADER, session.accountId);
    appendCleared(response, presented.names);
    response.headers.append(
      "Set-Cookie",
      sessionCookie(session.sessionId, session.token, session.expiresAt),
    );
    return response;
  } catch (error) {
    return jsonError(error);
  }
}

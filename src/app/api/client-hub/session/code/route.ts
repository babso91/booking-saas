import { requestLoginCode } from "@/features/client-hub/data/client-hub";
import { sendLoginCode } from "@/features/client-hub/data/login-email";
import { requestCodeSchema } from "@/features/client-hub/schemas/client-hub";
import { getEmailTransport } from "@/features/notifications/transport";
import { assertSameOrigin } from "@/features/client-hub/data/route";
import { trustedClientIp } from "@/lib/client-identity";
import { AppException, validationException } from "@/lib/errors";
import { jsonError, jsonOk, readJsonBody } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// POST /api/client-hub/session/code — body { email }.
// 202 { challengeId, expiresAt }: a 6-digit code was sent to that address.
// The answer is the same whether or not the address is known anywhere.
// The code goes to the canonical address it is bound to (ASCII only).
// 403 forbidden for a cross-site request (see assertSameOrigin);
// 429 rate_limited; 503 client_hub_unavailable when email delivery or the
// trusted ingress is not configured (no code is issued), or the send failed.
export async function POST(request: Request) {
  try {
    assertSameOrigin(request, true);
    let clientIp: string;
    try {
      clientIp = trustedClientIp(request);
    } catch {
      throw new AppException("client_hub_unavailable");
    }
    const parsed = requestCodeSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw validationException(parsed.error);

    const transport = getEmailTransport();
    if (!transport) {
      console.error(
        "Client Hub login refused: email delivery is not configured.",
      );
      throw new AppException("client_hub_unavailable");
    }

    const challenge = await requestLoginCode(
      createAdminSupabaseClient() as AppSupabaseClient,
      parsed.data.email,
      clientIp,
    );

    try {
      await sendLoginCode(transport, {
        to: challenge.email,
        code: challenge.code,
        challengeId: challenge.challengeId,
      });
    } catch {
      // Never logs the address or the code.
      console.error("Client Hub login code could not be sent.");
      throw new AppException("client_hub_unavailable");
    }

    return jsonOk(
      { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt },
      { status: 202 },
    );
  } catch (error) {
    return jsonError(error);
  }
}

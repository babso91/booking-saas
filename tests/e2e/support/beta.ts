import { createClient } from "@supabase/supabase-js";
import { inject } from "vitest";

import { hashInvitationToken } from "@/features/beta/token";
import type { Database } from "@/types/database.generated";

import { createBetaInvitation } from "../../../scripts/beta-invite.mjs";

// The private beta (docs/BETA_ACCESS.md): the professionals of the browser
// journeys are invited ones. Their invitation is made by the operator's
// command and accepted for their account, as the sign-up does.
export async function inviteAccount(email: string, userId: string) {
  const env = inject("e2e");
  const service = createClient<Database>(env.apiUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { url } = await createBetaInvitation(service, {
    email,
    days: 7,
    appUrl: env.appUrl,
  });
  const token = new URL(url).searchParams.get("invitation")!;
  const { data, error } = await service.rpc("accept_beta_invitation", {
    p_token_hash: hashInvitationToken(token),
    p_email: email,
    p_user_id: userId,
  });
  if (error || data !== "accepted") {
    throw new Error(`invitation not accepted: ${error?.message ?? data}`);
  }
}

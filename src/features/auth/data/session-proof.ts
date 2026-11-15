import "server-only";

import { AppException } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// What an invitation is accepted against: the session that proved who she
// is (docs/BETA_ACCESS.md, docs/TEAM_CONTRACT.md). Server only: never
// exported from a "use server" file, where it would become an action.

/** A recovery link followed within this time is a proof of her mailbox. */
export const RECOVERY_PROOF_MAX_AGE_SECONDS = 60 * 60;

/**
 * The session of this request's own JWT (its `session_id` claim), verified,
 * for the signed-in `userId`.
 */
export async function currentSessionId(
  client: AppSupabaseClient,
  userId: string,
): Promise<{
  sessionId: string;
  amr: { method: string; timestamp: number }[];
}> {
  const { data, error } = await client.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims || claims.sub !== userId || !claims.session_id) {
    throw new AppException("unauthenticated");
  }
  const amr = (claims.amr ?? []).flatMap((entry) =>
    typeof entry === "string" ? [] : [entry],
  );
  return { sessionId: claims.session_id as string, amr };
}

/** Did this session come from a recovery link, followed within the hour? */
export function isFreshRecovery(
  amr: { method: string; timestamp: number }[],
): boolean {
  const now = Math.floor(Date.now() / 1000);
  return amr.some(
    (entry) =>
      entry.method === "recovery" &&
      now - entry.timestamp <= RECOVERY_PROOF_MAX_AGE_SECONDS,
  );
}

/** Ends every other session of the signed-in account, or throws. */
export async function endOtherSessions(
  client: AppSupabaseClient,
): Promise<void> {
  const { error } = await client.auth.signOut({ scope: "others" });
  if (error) {
    console.error("Other sessions not ended", error.code ?? error.status);
    throw new AppException("session_revocation_failed");
  }
}

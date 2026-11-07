// Types of scripts/beta-invite.mjs (used by its tests).
import type { SupabaseClient } from "@supabase/supabase-js";

export function generateInvitationToken(): string;
export function hashInvitationToken(token: string): string;
export function createBetaInvitation(
  // Any service-role client (typed or not).
  client: Pick<SupabaseClient, "rpc">,
  input: { email: string; days: number; note?: string; appUrl: string },
): Promise<{ id: string; url: string; expiresAt: string }>;

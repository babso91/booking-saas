import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type {
  ClaimInput,
  WaitlistRequestInput,
} from "@/features/waitlist-server/schemas";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Waiting list (docs/WAITLIST_CONTRACT.md); every rule is PostgreSQL's
// (20261115140000_waitlist.sql). Tokens are created here, sent by email in
// a URL fragment, and only their SHA-256 reaches the database.

export type WaitlistOffer = {
  id: string;
  version: number;
  state: "offered" | "expired" | "unavailable" | "booked";
  serviceName: string;
  startsAt: string;
  endsAt: string;
  localStartsAt: string;
  timezone: string;
  businessName: string;
  priceCents: number;
  durationMinutes: number;
  currency: string;
  quoteRevision: string;
  expiresAt: string;
  requestActive: boolean;
};

export type CreatedRequest = {
  id: string;
  state: "pending_confirmation" | "active";
  activeUntil: string;
  replayed: boolean;
  businessName?: string;
  firstName?: string;
  email?: string;
};

export type MatchedOffer = {
  offerId: string;
  token: string;
  email: string;
  firstName: string;
  businessName: string;
  serviceName: string;
  startsAt: string;
  timezone: string;
  expiresAt: string;
};

export const newWaitlistToken = () => randomBytes(32).toString("hex");
export const hashWaitlistToken = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

type Rpc = {
  data: unknown;
  error: Parameters<typeof databaseException>[0] | null;
};
type RpcCaller = (fn: string, args: object) => Promise<Rpc>;

async function call<T>(admin: AppSupabaseClient, fn: string, args: object) {
  const { data, error } = await (admin.rpc as unknown as RpcCaller)(fn, args);
  if (error) throw databaseException(error);
  return data as T;
}

export const createRequest = (
  admin: AppSupabaseClient,
  input: WaitlistRequestInput,
  clientIp: string,
  confirmToken: string,
) =>
  call<CreatedRequest>(admin, "waitlist_create_request", {
    p_slug: input.businessSlug,
    p_service_id: input.serviceId,
    p_option_choice_ids: input.optionChoiceIds,
    p_windows: input.windows,
    p_any_time: input.anyTime,
    p_first_name: input.firstName,
    p_email: input.email,
    p_request_id: input.requestId,
    p_client_ip: clientIp,
    p_confirm_token_hash: hashWaitlistToken(confirmToken),
  });

export const confirmRequest = (admin: AppSupabaseClient, token: string) =>
  call<{ id: string; state: string; activeUntil: string }>(
    admin,
    "waitlist_confirm_request",
    { p_token_hash: hashWaitlistToken(token) },
  );

export const readOffer = (
  admin: AppSupabaseClient,
  offerId: string,
  token: string,
) =>
  call<WaitlistOffer>(admin, "waitlist_offer", {
    p_offer_id: offerId,
    p_token_hash: hashWaitlistToken(token),
  });

/** The claimed offer; a lost slot is thrown as `offer_unavailable` (the offer is already marked). */
export async function claimOffer(
  admin: AppSupabaseClient,
  offerId: string,
  token: string,
  input: ClaimInput,
  clientIp: string,
): Promise<{ offer: WaitlistOffer; appointmentId: string | null }> {
  const result = await call<{
    offer: WaitlistOffer;
    appointmentId?: string;
    error?: string;
  }>(admin, "waitlist_claim", {
    p_offer_id: offerId,
    p_token_hash: hashWaitlistToken(token),
    p_request_id: input.requestId,
    p_expected_version: input.expectedVersion,
    p_expected_quote_revision: input.expectedQuoteRevision,
    p_client_ip: clientIp,
  });
  if (result.error === "offer_unavailable") {
    throw new AppException("offer_unavailable");
  }
  return { offer: result.offer, appointmentId: result.appointmentId ?? null };
}

export const matchReleases = (admin: AppSupabaseClient, budget = 20) =>
  call<{ signals: number; offers: MatchedOffer[] }>(admin, "waitlist_match", {
    p_budget: budget,
  });

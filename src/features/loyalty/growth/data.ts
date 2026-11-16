import "server-only";

import { randomBytes } from "node:crypto";

import type { GrowthRulesInput } from "@/features/loyalty/growth/schemas";
import { getPublicEnv } from "@/lib/env/public";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// VIP tiers and referral (docs/LOYALTY_TIERS_CONTRACT.md), on the loyalty
// ledger: no second ledger, every credit is a ledger entry.

export type TierDto = {
  id: string;
  name: string;
  threshold: number;
  perk: string | null;
};

export type TierProgressDto = {
  tiers: TierDto[];
  tierId: string | null;
  currentValue: number;
  nextThreshold: number | null;
  windowDays: number;
  /** When the oldest counted visit leaves the window; null without any. */
  windowEnd: string | null;
  ruleVersion: number;
};

export type GrowthRulesDto = {
  tiers: TierDto[];
  windowDays: number;
  referralPoints: number | null;
  version: number;
};

export type ReferralLinkDto = {
  url: string;
  expiresAt: string;
  /** unavailable: the business stopped its referral offer. */
  state: "active" | "expired" | "revoked" | "unavailable";
};

type LinkRow = {
  code: string;
  slug: string;
  expiresAt: string;
  state: ReferralLinkDto["state"];
};

export async function getGrowthRules(
  client: AppSupabaseClient,
  businessId: string,
): Promise<GrowthRulesDto> {
  const { data, error } = await client.rpc("loyalty_get_growth_rules", {
    p_business_id: businessId,
  });
  if (error) throw databaseException(error);
  return data as unknown as GrowthRulesDto;
}

export async function setGrowthRules(
  client: AppSupabaseClient,
  businessId: string,
  input: GrowthRulesInput,
): Promise<GrowthRulesDto> {
  const { data, error } = await client.rpc("loyalty_set_growth_rules", {
    p_business_id: businessId,
    p_tiers: input.tiers.map((tier) => ({
      name: tier.name,
      threshold: tier.threshold,
      perk: tier.perk ?? null,
    })),
    p_window_days: input.windowDays,
    p_referral_points: input.referralPoints as number,
    p_expected_version: input.expectedVersion,
  });
  if (error) throw databaseException(error);
  return data as unknown as GrowthRulesDto;
}

export async function getClientTierProgress(
  client: AppSupabaseClient,
  businessId: string,
  clientId: string,
): Promise<TierProgressDto> {
  const { data, error } = await client.rpc("loyalty_client_tier_progress", {
    p_business_id: businessId,
    p_client_id: clientId,
  });
  if (error) throw databaseException(error);
  return data as unknown as TierProgressDto;
}

export async function getHubTierProgress(
  admin: AppSupabaseClient,
  token: string,
  businessId: string,
): Promise<TierProgressDto> {
  const { data, error } = await admin.rpc("client_hub_tier_progress", {
    p_session_token: token,
    p_business_id: businessId,
  });
  if (error) throw databaseException(error);
  return data as unknown as TierProgressDto;
}

/** Her link: the business's public page, with the code as a parameter. */
function toLink(row: LinkRow | null): ReferralLinkDto | null {
  if (!row) return null;
  const url = new URL(
    `/b/${row.slug}`,
    new URL(getPublicEnv().NEXT_PUBLIC_APP_URL).origin,
  );
  url.searchParams.set("parrainage", row.code);
  return { url: url.toString(), expiresAt: row.expiresAt, state: row.state };
}

export async function getReferralLink(
  admin: AppSupabaseClient,
  token: string,
  businessId: string,
): Promise<ReferralLinkDto | null> {
  const { data, error } = await admin.rpc("client_hub_referral_link", {
    p_session_token: token,
    p_business_id: businessId,
  });
  if (error) throw databaseException(error);
  return toLink(data as unknown as LinkRow | null);
}

export async function createReferralLink(
  admin: AppSupabaseClient,
  token: string,
  businessId: string,
  requestId: string,
): Promise<ReferralLinkDto> {
  const { data, error } = await admin.rpc("client_hub_create_referral_link", {
    p_session_token: token,
    p_business_id: businessId,
    p_request_id: requestId,
    p_code: randomBytes(16).toString("base64url"),
  });
  if (error) throw databaseException(error);
  return toLink(data as unknown as LinkRow)!;
}

export type ReferralClaim =
  | "claimed"
  | "already_claimed"
  | "already_referred"
  | "ineligible"
  | "unavailable";

/** The booking was made through a referral link (the booking route only). */
export async function claimReferral(
  service: AppSupabaseClient,
  code: string,
  appointmentId: string,
): Promise<ReferralClaim> {
  const { data, error } = await service.rpc("referral_claim", {
    p_code: code,
    p_appointment_id: appointmentId,
  });
  if (error) throw databaseException(error);
  return data as ReferralClaim;
}

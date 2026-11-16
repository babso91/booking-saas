"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  getClientTierProgress,
  getGrowthRules,
  setGrowthRules,
} from "@/features/loyalty/growth/data";
import {
  growthRulesSchema,
  tierProgressSchema,
} from "@/features/loyalty/growth/schemas";

// VIP tiers and referral, the professional's side
// (docs/LOYALTY_TIERS_CONTRACT.md).

export async function getLoyaltyGrowthRulesAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    getGrowthRules(client, businessId),
  );
}

/** Owner and admin; `version_conflict` on a stale `expectedVersion`. */
export async function setLoyaltyGrowthRulesAction(input: unknown) {
  const result = await runBusinessAction(
    growthRulesSchema,
    input,
    ({ client, businessId }, data) => setGrowthRules(client, businessId, data),
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

/** One customer's tier, for her CRM profile. */
export async function getTierProgressAction(input: unknown) {
  return runBusinessAction(
    tierProgressSchema,
    input,
    ({ client, businessId }, { clientId }) =>
      getClientTierProgress(client, businessId, clientId),
  );
}

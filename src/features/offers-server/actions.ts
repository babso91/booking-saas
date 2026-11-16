"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  createPromotion,
  listPromotions,
  setPromotionState,
} from "@/features/offers-server/data";
import {
  promotionInputSchema,
  promotionStateSchema,
} from "@/features/offers-server/schemas";

// Offers and codes, the professional's side (owner and admin;
// docs/OFFER_QUOTE_CONTRACT.md). A rule never changes once created: pause
// it and create another.

export async function listPromotionsAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    listPromotions(client, businessId),
  );
}

/** `coupon_code_taken` for a code already used in the business. */
export async function createPromotionAction(input: unknown) {
  const result = await runBusinessAction(
    promotionInputSchema,
    input,
    ({ client, businessId }, data) => createPromotion(client, businessId, data),
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

/** pause or resume; `version_conflict` on a stale version. */
export async function setPromotionStateAction(input: unknown) {
  const result = await runBusinessAction(
    promotionStateSchema,
    input,
    ({ client, businessId }, data) =>
      setPromotionState(client, businessId, data),
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

import "server-only";

import type {
  OfferQuoteInput,
  PromotionInput,
} from "@/features/offers-server/schemas";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Offers, codes and the quote tied to the chosen slot
// (docs/OFFER_QUOTE_CONTRACT.md). The browser never computes the price it
// confirms: it shows this quote and sends its reference to the booking.

export type OfferQuoteDto = {
  quoteRef: string;
  startsAt: string;
  baseCents: number;
  optionsCents: number;
  discountCents: number;
  totalCents: number;
  currency: string;
  durationMinutes: number;
  depositCents: number | null;
  validUntil: string;
  discountLabel: string | null;
  discountSource: "offer" | "code" | null;
};

export type PromotionDto = Record<string, unknown> & {
  id: string;
  version: number;
  state: "active" | "paused";
};

export async function getOfferQuote(
  service: AppSupabaseClient,
  input: OfferQuoteInput,
  clientIp: string,
): Promise<OfferQuoteDto> {
  const { data, error } = await service.rpc("offer_quote", {
    p_slug: input.slug,
    p_service_id: input.serviceId,
    p_option_choice_ids: input.optionChoiceIds,
    p_starts_at: input.startsAt,
    p_coupon: (input.coupon ?? null) as string,
    p_client_ip: clientIp,
  });
  if (error) throw databaseException(error);
  // A refused code is answered, not raised, so that it stays logged.
  if ((data as { error?: string }).error === "coupon_refused") {
    throw new AppException("coupon_refused");
  }
  return data as unknown as OfferQuoteDto;
}

export async function listPromotions(
  client: AppSupabaseClient,
  businessId: string,
): Promise<PromotionDto[]> {
  const { data, error } = await client.rpc("promotion_list", {
    p_business_id: businessId,
  });
  if (error) throw databaseException(error);
  return data as unknown as PromotionDto[];
}

export async function createPromotion(
  client: AppSupabaseClient,
  businessId: string,
  input: PromotionInput,
): Promise<PromotionDto> {
  const { data, error } = await client.rpc("promotion_create", {
    p_business_id: businessId,
    p_input: input,
  });
  if (error) throw databaseException(error);
  return data as unknown as PromotionDto;
}

export async function setPromotionState(
  client: AppSupabaseClient,
  businessId: string,
  input: { promotionId: string; state: string; expectedVersion: number },
): Promise<PromotionDto> {
  const { data, error } = await client.rpc("promotion_set_state", {
    p_business_id: businessId,
    p_promotion_id: input.promotionId,
    p_state: input.state,
    p_expected_version: input.expectedVersion,
  });
  if (error) throw databaseException(error);
  return data as unknown as PromotionDto;
}

import "server-only";

import type { CompleteOnboardingInput } from "@/features/onboarding/schemas/onboarding";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

export type OnboardedBusinessDto = {
  businessId: string;
  slug: string;
  businessName: string;
  timezone: string;
};

export type SlugAvailabilityDto = {
  /** Normalised slug, exactly what completeOnboarding would store. */
  slug: string;
  available: boolean;
  reason: "available" | "taken" | "reserved" | "invalid";
};

/**
 * Finalises onboarding for the signed-in user (auth.uid()) in one database
 * transaction: profile, business, settings, owner membership and loyalty
 * program. The caller's identity is never a parameter.
 */
export async function completeOnboarding(
  client: AppSupabaseClient,
  input: CompleteOnboardingInput,
): Promise<OnboardedBusinessDto> {
  const { data, error } = await client.rpc("complete_onboarding", {
    p_first_name: input.firstName,
    p_last_name: input.lastName,
    p_business_name: input.businessName,
    p_slug: input.slug,
    p_timezone: input.timezone,
    p_description: input.description,
    p_contact_email: input.contactEmail,
    p_phone: input.phone,
    p_location: input.location,
    p_cancellation_policy: input.cancellationPolicy,
    p_minimum_booking_notice_minutes: input.minimumBookingNoticeMinutes,
    p_maximum_booking_advance_days: input.maximumBookingAdvanceDays,
    p_buffer_minutes: input.bufferMinutes,
  });

  if (error) {
    throw databaseException(error);
  }

  const row = data[0];

  if (!row) {
    throw new AppException("internal", {
      message: "Onboarding returned no row.",
    });
  }

  return {
    businessId: row.business_id,
    slug: row.slug,
    businessName: row.business_name,
    timezone: row.timezone,
  };
}

/** UX pre-check only: the unique constraint remains the final authority. */
export async function checkSlugAvailability(
  client: AppSupabaseClient,
  slug: string,
): Promise<SlugAvailabilityDto> {
  const { data, error } = await client.rpc("check_slug_availability", {
    p_slug: slug,
  });

  if (error) {
    throw databaseException(error);
  }

  const row = data[0];

  if (!row) {
    throw new AppException("internal", {
      message: "Slug check returned no row.",
    });
  }

  return {
    slug: row.slug,
    available: row.available,
    reason: row.reason as SlugAvailabilityDto["reason"],
  };
}

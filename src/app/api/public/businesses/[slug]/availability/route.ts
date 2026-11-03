import type { NextRequest } from "next/server";

import { getAvailableSlots } from "@/features/availability/data/slots";
import { quotePublicService } from "@/features/catalog/data/catalog";
import { availabilityQuerySchema } from "@/features/availability/schemas/availability";
import { getPublicBusiness } from "@/features/businesses/data/public-business";
import { AppException, validationException } from "@/lib/errors";
import { jsonError, jsonOk } from "@/lib/http";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

// GET /api/public/businesses/:slug/availability?serviceId=…&date=YYYY-MM-DD
// `date` is a calendar day in the business time zone; slots are UTC instants.
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/public/businesses/[slug]/availability">,
) {
  try {
    const parsed = availabilityQuerySchema.safeParse({
      slug: (await ctx.params).slug,
      serviceId: request.nextUrl.searchParams.get("serviceId"),
      date: request.nextUrl.searchParams.get("date"),
      optionChoiceIds:
        request.nextUrl.searchParams
          .get("optionChoiceIds")
          ?.split(",")
          .filter(Boolean) ?? undefined,
    });

    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    const client = createPublicSupabaseClient();
    const business = await getPublicBusiness(client, parsed.data.slug);

    if (!business) {
      throw new AppException("business_not_found");
    }

    const [slots, quote] = await Promise.all([
      getAvailableSlots(client, parsed.data),
      quotePublicService(
        client,
        parsed.data.slug,
        parsed.data.serviceId,
        parsed.data.optionChoiceIds,
      ),
    ]);

    return jsonOk({
      date: parsed.data.date,
      timezone: business.timezone,
      slots,
      // The price and duration these slots are for, as the server books them.
      quote,
    });
  } catch (error) {
    return jsonError(error);
  }
}

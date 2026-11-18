import type { NextRequest } from "next/server";

import { getPublicAvailability } from "@/features/catalog/data/catalog";
import {
  availabilityQuerySchema,
  localDateSchema,
} from "@/features/availability/schemas/availability";
import { getPublicBusiness } from "@/features/businesses/data/public-business";
import { AppException, validationException } from "@/lib/errors";
import { jsonError, jsonOk } from "@/lib/http";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import { databaseException } from "@/lib/supabase/errors";
import { daysBetweenLocalDates } from "@/lib/time/local-date";

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
    const through = request.nextUrl.searchParams.get("through");
    if (through !== null) {
      const end = localDateSchema.safeParse(through);
      const span = end.success
        ? daysBetweenLocalDates(parsed.data.date, end.data)
        : -1;
      if (!end.success || span < 0 || span > 30)
        throw new AppException("validation_error");
      const { data, error } = await client.rpc(
        "get_public_availability_calendar",
        {
          p_slug: parsed.data.slug,
          p_service_id: parsed.data.serviceId,
          p_from: parsed.data.date,
          p_to: end.data,
          p_option_choice_ids: parsed.data.optionChoiceIds,
        },
      );
      if (error) throw databaseException(error);
      return jsonOk({ days: data });
    }
    const business = await getPublicBusiness(client, parsed.data.slug);

    if (!business) {
      throw new AppException("business_not_found");
    }

    // One read of the catalogue for both: the slots are always for the
    // quote's duration, even if the service changes meanwhile.
    const { slots, quote } = await getPublicAvailability(client, parsed.data);

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

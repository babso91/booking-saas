"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  bookingPolicySchema,
  type BookingPolicy,
} from "@/features/booking-policy/schemas";
import { databaseException } from "@/lib/supabase/errors";

// Sets her Hub policy (owner or admin). Appointments already made keep the
// policy they were made under (docs/CLIENT_HUB_CONTRACT.md).
export async function setBookingPolicyAction(input: unknown) {
  const result = await runBusinessAction(
    bookingPolicySchema,
    input,
    async ({ client, businessId }, data) => {
      const { data: saved, error } = await (
        client.rpc as unknown as (
          fn: string,
          args: object,
        ) => Promise<{
          data: unknown;
          error: Parameters<typeof databaseException>[0] | null;
        }>
      )("set_booking_policy", {
        p_business_id: businessId,
        p_cancellation_lead_minutes: data.cancellationLeadMinutes,
        p_reschedule_lead_minutes: data.rescheduleLeadMinutes,
      });
      if (error) throw databaseException(error);
      return saved as BookingPolicy;
    },
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

// Opens or closes her waiting list. Closing stops every open offer.
export async function setWaitlistEnabledAction(input: unknown) {
  const result = await runBusinessAction(
    z.object({ enabled: z.boolean() }),
    input,
    async ({ client, businessId }, data) => {
      const { data: saved, error } = await (
        client.rpc as unknown as (
          fn: string,
          args: object,
        ) => Promise<{
          data: unknown;
          error: Parameters<typeof databaseException>[0] | null;
        }>
      )("set_waitlist_enabled", {
        p_business_id: businessId,
        p_enabled: data.enabled,
      });
      if (error) throw databaseException(error);
      return { enabled: saved === true };
    },
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

import { z } from "zod";

// Her Hub policy: minutes before the start until which a client may cancel /
// move from her Hub; null: never from the Hub. Applies to new appointments.
const lead = z.number().int().min(0).max(43_200).nullable();

export const bookingPolicySchema = z.object({
  cancellationLeadMinutes: lead,
  rescheduleLeadMinutes: lead,
});

export type BookingPolicy = z.output<typeof bookingPolicySchema>;

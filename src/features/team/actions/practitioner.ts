"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import { kickCalendarOutbound } from "@/features/calendar/data/outbound-kick";
import { databaseException } from "@/lib/supabase/errors";

// What a practitioner may change (docs/TEAM_CONTRACT.md, « Rôle
// praticienne »): the outcome of her own visits, done or missed, and
// reopening one. Never a cancellation; another's visit answers
// appointment_not_found. The server checks it all again.

const setMyVisitStatusSchema = z.object({
  appointmentId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  status: z.enum(["completed", "no_show", "confirmed"]),
});

export async function setMyVisitStatusAction(input: unknown) {
  const result = await runBusinessAction(
    setMyVisitStatusSchema,
    input,
    async ({ client, businessId }, data) => {
      const { error } = await client.rpc("agenda_set_appointment_status", {
        p_business_id: businessId,
        p_appointment_id: data.appointmentId,
        p_expected_version: data.expectedVersion,
        p_status: data.status,
      });
      if (error) throw databaseException(error);
      kickCalendarOutbound({ businessId });
      return { appointmentId: data.appointmentId, status: data.status };
    },
  );
  if (result.ok) revalidatePath("/mon-agenda");
  return result;
}

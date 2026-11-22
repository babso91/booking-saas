"use server";

import { getAppointmentHistory } from "@/features/agenda/data/history";
import { appointmentIdSchema } from "@/features/agenda/schemas/agenda";
import { runBusinessAction } from "@/features/businesses/actions/run-business-action";

/** Who changed an appointment, and what (point 100). Read only. */
export async function getAppointmentHistoryAction(input: unknown) {
  return runBusinessAction(
    appointmentIdSchema,
    input,
    ({ client, businessId }, { appointmentId }) =>
      getAppointmentHistory(client, businessId, appointmentId),
  );
}

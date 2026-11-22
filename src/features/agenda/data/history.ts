import "server-only";

import { z } from "zod";

import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Who changed an appointment, and what (point 100). Read from
// public.appointment_history, which keeps the actor and the changed fields
// only. Contract: docs/PROFESSIONAL_AGENDA_CONTRACT.md, « Historique ».

const status = z.enum(["confirmed", "completed", "cancelled", "no_show"]);
const wallClock = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const window = z.object({ localStartsAt: wallClock, localEndsAt: wallClock });

const changeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("created"),
    serviceName: z.string().nullish(),
    status: status.nullish(),
    localStartsAt: wallClock.nullish(),
    localEndsAt: wallClock.nullish(),
    inSeries: z.boolean().nullish(),
  }),
  z.object({ type: z.literal("moved"), from: window, to: window }),
  z.object({
    type: z.literal("duration"),
    fromMinutes: z.number().int(),
    toMinutes: z.number().int(),
  }),
  z.object({
    type: z.literal("service"),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  z.object({ type: z.literal("options") }),
  z.object({
    type: z.literal("price"),
    fromCents: z.number().int().nullable(),
    toCents: z.number().int().nullable(),
    fromCurrency: z.string().nullable(),
    toCurrency: z.string().nullable(),
  }),
  z.object({
    type: z.literal("client"),
    fromName: z.string().nullable(),
    toName: z.string().nullable(),
  }),
  z.object({
    type: z.literal("staff"),
    fromName: z.string().nullable(),
    toName: z.string().nullable(),
  }),
  z.object({ type: z.literal("status"), from: status, to: status }),
  z.object({ type: z.literal("notes") }),
  z.object({ type: z.literal("untracked") }),
]);

const historySchema = z.object({
  timeZone: z.string(),
  truncated: z.boolean(),
  entries: z.array(
    z.object({
      id: z.number(),
      version: z.number(),
      localAt: wallClock,
      actor: z.object({
        kind: z.enum(["member", "client", "system"]),
        name: z.string().nullable(),
        isYou: z.boolean(),
      }),
      backfilled: z.boolean(),
      // A change of a kind this version does not know is left out.
      changes: z.array(z.unknown()).transform((items) =>
        items.flatMap((item) => {
          const parsed = changeSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        }),
      ),
    }),
  ),
});

export type AppointmentChange = z.infer<typeof changeSchema>;
export type AppointmentHistory = z.infer<typeof historySchema>;
export type AppointmentHistoryEntry = AppointmentHistory["entries"][number];

export async function getAppointmentHistory(
  client: AppSupabaseClient,
  businessId: string,
  appointmentId: string,
): Promise<AppointmentHistory> {
  const { data, error } = await client.rpc("appointment_history", {
    p_business_id: businessId,
    p_appointment_id: appointmentId,
  });
  if (error) throw databaseException(error);
  return historySchema.parse(data);
}

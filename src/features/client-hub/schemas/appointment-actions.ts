import { z } from "zod";

// Inputs of « annuler ou déplacer » from her Hub (docs/CLIENT_HUB_CONTRACT.md).
// PostgreSQL checks version, policy, time and availability again.

const expectedVersion = z.number().int().min(1).max(2_147_483_647);

export const cancelAppointmentSchema = z.object({
  requestId: z.uuid(),
  expectedVersion,
});

export const rescheduleAppointmentSchema = z.object({
  requestId: z.uuid(),
  expectedVersion,
  startsAt: z.iso.datetime({ offset: true }),
});

export const rescheduleSlotsQuerySchema = z.object({
  date: z.iso.date(),
});

export type CancelAppointmentInput = z.output<typeof cancelAppointmentSchema>;
export type RescheduleAppointmentInput = z.output<
  typeof rescheduleAppointmentSchema
>;

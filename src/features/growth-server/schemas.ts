import { z } from "zod";

// Inputs of campaigns (docs/GROWTH_CAMPAIGNS_CONTRACT.md). Closed V1
// criteria only; the database checks everything again.

export const audienceCriteriaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rebooking"),
    serviceIds: z.array(z.uuid()).min(1).max(50),
    afterDays: z.number().int().min(1).max(730),
  }),
  z.object({
    kind: z.literal("reactivation"),
    inactiveDays: z.number().int().min(1).max(1095),
  }),
]);

export const estimateSchema = z.object({
  criteria: audienceCriteriaSchema,
  channel: z.enum(["email", "sms"]),
  message: z.string().trim().min(1).max(2000),
});

export const scheduleSchema = z.object({
  estimateId: z.uuid(),
  maxUnits: z.number().int().min(1).max(100_000),
  requestId: z.uuid(),
});

export const campaignIdSchema = z.object({ campaignId: z.uuid() });

export const setStateSchema = z.object({
  campaignId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  requestId: z.uuid(),
  action: z.enum(["pause", "resume", "cancel"]),
});

export type EstimateInput = z.output<typeof estimateSchema>;
export type ScheduleInput = z.output<typeof scheduleSchema>;
export type SetStateInput = z.output<typeof setStateSchema>;

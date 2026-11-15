import { z } from "zod";

// Inputs of the waiting list (docs/WAITLIST_CONTRACT.md). PostgreSQL checks
// windows, horizon, service, quote and limits again.

export const waitlistRequestSchema = z.object({
  requestId: z.uuid(),
  businessSlug: z.string().min(1).max(100),
  serviceId: z.uuid(),
  optionChoiceIds: z.array(z.uuid()).max(50),
  windows: z
    .array(
      z.object({
        localDate: z.iso.date(),
        startMinute: z.number().int().min(0).max(1439),
        endMinute: z.number().int().min(1).max(1440),
      }),
    )
    .max(5),
  anyTime: z.boolean(),
  firstName: z.string().trim().min(1).max(80),
  email: z.email().trim().toLowerCase().max(254),
  contactConsent: z.literal(true),
});

/** A capability token: 32 random bytes, hex. */
export const waitlistTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const confirmSchema = z.object({ token: waitlistTokenSchema });

export const claimSchema = z.object({
  requestId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  expectedQuoteRevision: z.string().regex(/^[0-9a-f]{32}$/),
});

export type WaitlistRequestInput = z.output<typeof waitlistRequestSchema>;
export type ClaimInput = z.output<typeof claimSchema>;

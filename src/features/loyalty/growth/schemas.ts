import { z } from "zod";

// Inputs of VIP tiers and referral (docs/LOYALTY_TIERS_CONTRACT.md). The
// database checks everything again.

/** A referral link's code: 16 random bytes, base64url. */
export const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export const growthRulesSchema = z.object({
  tiers: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(40),
        threshold: z.number().int().min(1).max(500),
        perk: z.string().trim().max(120).nullable().optional(),
      }),
    )
    .max(5),
  windowDays: z.number().int().min(30).max(730),
  /** Points to the referrer for a referred first visit; null: no referral. */
  referralPoints: z.number().int().min(1).max(10_000).nullable(),
  /** 0 before the first save. */
  expectedVersion: z.number().int().min(0),
});

export const tierProgressSchema = z.object({ clientId: z.uuid() });

export const createReferralLinkSchema = z.object({ requestId: z.uuid() });

export type GrowthRulesInput = z.output<typeof growthRulesSchema>;

import { z } from "zod";

// Inputs of marketing consent and unsubscribe (docs/MARKETING_CONSENT_CONTRACT.md).
// The database checks everything again.

/** An unsubscribe link's token (`uns_` + 32 random bytes, base64url). */
export const UNSUBSCRIBE_TOKEN_PATTERN = /^uns_[A-Za-z0-9_-]{43}$/;

export const consentChannelSchema = z.enum(["email", "sms"]);

export const clientConsentsSchema = z.object({ clientId: z.uuid() });

export const setConsentSchema = z
  .object({
    clientId: z.uuid(),
    purpose: z.literal("marketing"),
    channel: consentChannelSchema,
    action: z.enum(["grant", "withdraw"]),
    /** The version of the wording she agreed to; required to grant. */
    proofVersion: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional(),
    requestId: z.uuid(),
  })
  .refine((input) => input.action !== "grant" || input.proofVersion, {
    path: ["proofVersion"],
    message: "La version du texte accepté est obligatoire.",
  });

export const unsubscribeTokenSchema = z
  .string()
  .regex(UNSUBSCRIBE_TOKEN_PATTERN);

export type ConsentChannel = z.output<typeof consentChannelSchema>;
export type SetConsentInput = z.output<typeof setConsentSchema>;

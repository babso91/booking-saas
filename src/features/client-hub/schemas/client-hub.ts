import { z } from "zod";

// Inputs of the Client Hub routes (customer) and actions (professional).
// PostgreSQL revalidates everything (20261021090000_client_hub.sql).

const email = z.string().trim().min(3).max(254);

export const requestCodeSchema = z.object({ email });

export const verifyCodeSchema = z.object({
  challengeId: z.uuid(),
  email,
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{8}$/, "Le code contient 8 chiffres."),
});

export const endSessionSchema = z.object({
  /** Also end every other session of the account. */
  all: z.boolean().default(false),
});

/** Opaque cursor of the appointment lists: base64url of "startsAt|id". */
export const appointmentsQuerySchema = z.object({
  scope: z.enum(["upcoming", "past"]),
  cursor: z
    .string()
    .max(200)
    .optional()
    .transform((value, context) => {
      if (value === undefined) return undefined;
      const decoded = Buffer.from(value, "base64url").toString("utf8");
      const [startsAt, id] = decoded.split("|");
      const parsed = z
        .object({ startsAt: z.iso.datetime({ offset: true }), id: z.uuid() })
        .safeParse({ startsAt, id });
      if (!parsed.success) {
        context.addIssue({ code: "custom", message: "Curseur invalide." });
        return z.NEVER;
      }
      return parsed.data;
    }),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const ledgerQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^[1-9]\d{0,17}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const businessIdSchema = z.uuid();
export const appointmentIdSchema = z.uuid();

export const clientHubAccessSchema = z.object({ clientId: z.uuid() });
export const setClientHubAccessSchema = z.object({
  clientId: z.uuid(),
  granted: z.boolean(),
  /**
   * The email the professional was shown. A grant is refused
   * (stale_client) if the record has another one by now.
   */
  expectedEmail: z.string().trim().max(254).optional(),
});

export function encodeAppointmentCursor(startsAt: string, id: string) {
  return Buffer.from(`${startsAt}|${id}`, "utf8").toString("base64url");
}

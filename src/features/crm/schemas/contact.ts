import { z } from "zod";

// A customer's identity and contact as typed by a professional: one set of
// rules for every path that writes them (agenda creation, CRM creation and
// edition). PostgreSQL applies the same rules and stays the authority (the
// email is canonicalized there: private.canonical_email).

/**
 * Free text: Unicode NFC first (a precomposed "É" and "E" + combining acute
 * become the same string, as in the database), then trimmed.
 */
const nfcTrimmed = () =>
  z.string().transform((value) => value.normalize("NFC").trim());

const optionalText = (max: number) =>
  nfcTrimmed()
    .pipe(z.string().max(max))
    .nullish()
    .transform((value) => (value ? value : null));

export const clientContactFields = {
  firstName: nfcTrimmed().pipe(z.string().min(1).max(120)),
  lastName: optionalText(120),
  // Trimmed and lower-cased before validation: " Test@Example.com " is
  // test@example.com. Empty → no email.
  email: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.union([z.literal(""), z.email("Email invalide.").max(254)]))
    .nullish()
    .transform((value) => (value ? value : null)),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ().-]{6,30}$/, "Téléphone invalide.")
    .nullish()
    .or(z.literal("").transform(() => null))
    .transform((value) => value ?? null),
};

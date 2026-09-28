import { z } from "zod";

// Mirrors the CHECK constraint on businesses.slug.
export const businessSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Identifiant de page invalide.");

import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email("Adresse email invalide."));

// Mirrors auth.minimum_password_length in supabase/config.toml. bcrypt only
// uses the first 72 bytes, hence the upper bound.
export const passwordSchema = z
  .string()
  .min(10, "Le mot de passe doit contenir au moins 10 caractères.")
  .max(72, "Le mot de passe doit contenir au plus 72 caractères.");

const optionalName = z
  .string()
  .trim()
  .max(80)
  .optional()
  .transform((value) => (value ? value : undefined));

export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  firstName: optionalName,
  lastName: optionalName,
});

export const signInSchema = z.object({
  email: emailSchema,
  // No length rule on sign-in: never reveal the password policy of an account.
  password: z.string().min(1, "Le mot de passe est obligatoire.").max(72),
});

export type SignUpInput = z.output<typeof signUpSchema>;
export type SignInInput = z.output<typeof signInSchema>;

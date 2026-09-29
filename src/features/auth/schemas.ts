import { z } from "zod";

// Client-side validation for instant feedback only. The server revalidates.
export const PASSWORD_MIN_LENGTH = 8;

const email = z
  .string()
  .trim()
  .min(1, "Indique ton email.")
  .pipe(z.email("Cet email semble incomplet."));

export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Indique ton mot de passe."),
});

export const signUpSchema = z.object({
  email,
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Au moins ${PASSWORD_MIN_LENGTH} caractères.`)
    .max(72, "72 caractères maximum."),
});

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

// First message per field, keyed by field name.
export function firstFieldErrors<K extends string>(
  error: z.ZodError,
): FieldErrors<K> {
  const result: Partial<Record<string, string>> = {};

  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "_root");
    result[key] ??= issue.message;
  }

  return result as FieldErrors<K>;
}

export type PasswordStrength = 0 | 1 | 2 | 3;

// Lightweight, encouraging indicator — not a security control.
export function passwordStrength(password: string): PasswordStrength {
  if (password.length < PASSWORD_MIN_LENGTH) return 0;

  let score = 1;
  if (password.length >= 12) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 0.5;
  if (/\d/.test(password)) score += 0.5;
  if (/[^A-Za-z0-9]/.test(password)) score += 0.5;

  return Math.min(3, Math.floor(score)) as PasswordStrength;
}

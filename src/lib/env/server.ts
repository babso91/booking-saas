import "server-only";

import { z } from "zod";

const adminEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

const emailEnvSchema = z.object({
  CRON_SECRET: z.string().min(32),
  RESEND_API_KEY: z.string().startsWith("re_"),
  RESEND_FROM_EMAIL: z.string().min(3),
});

export function getAdminEnv() {
  return adminEnvSchema.parse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
}

export function getEmailEnv() {
  return emailEnvSchema.parse({
    CRON_SECRET: process.env.CRON_SECRET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
  });
}

// External calendars (Google Calendar). Absent or invalid: the integration
// is disabled and every calendar operation answers calendar_not_configured.
const base64Key = z
  .string()
  .refine(
    (value) => Buffer.from(value, "base64").length === 32,
    "Expected a base64-encoded 32-byte key.",
  );

const calendarEnvSchema = z.object({
  GOOGLE_CALENDAR_CLIENT_ID: z.string().min(1),
  GOOGLE_CALENDAR_CLIENT_SECRET: z.string().min(1),
  GOOGLE_CALENDAR_REDIRECT_URI: z.url(),
  // Push notifications need a public HTTPS endpoint; without it, changes are
  // picked up by the periodic job only.
  GOOGLE_CALENDAR_WEBHOOK_URL: z
    .url()
    .refine((value) => value.startsWith("https://"))
    .optional(),
  CALENDAR_TOKEN_ENCRYPTION_KEY: base64Key,
  // Former keys, still accepted for decryption during a rotation.
  CALENDAR_TOKEN_PREVIOUS_KEYS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean),
    )
    .pipe(z.array(base64Key)),
});

export type CalendarEnv = z.output<typeof calendarEnvSchema>;

/** Calendar settings, or null when the integration is not configured. */
export function getCalendarEnv(): CalendarEnv | null {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const parsed = calendarEnvSchema.safeParse({
    GOOGLE_CALENDAR_CLIENT_ID: process.env.GOOGLE_CALENDAR_CLIENT_ID,
    GOOGLE_CALENDAR_CLIENT_SECRET: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    GOOGLE_CALENDAR_REDIRECT_URI:
      process.env.GOOGLE_CALENDAR_REDIRECT_URI ||
      (appUrl
        ? new URL("/api/calendar/google/callback", appUrl).toString()
        : undefined),
    GOOGLE_CALENDAR_WEBHOOK_URL:
      process.env.GOOGLE_CALENDAR_WEBHOOK_URL || undefined,
    CALENDAR_TOKEN_ENCRYPTION_KEY: process.env.CALENDAR_TOKEN_ENCRYPTION_KEY,
    CALENDAR_TOKEN_PREVIOUS_KEYS: process.env.CALENDAR_TOKEN_PREVIOUS_KEYS,
  });
  return parsed.success ? parsed.data : null;
}

const cronEnvSchema = z.object({ CRON_SECRET: z.string().min(32) });

/** Secret of the scheduled jobs, or null (jobs then refuse every call). */
export function getCronSecret(): string | null {
  const parsed = cronEnvSchema.safeParse({
    CRON_SECRET: process.env.CRON_SECRET,
  });
  return parsed.success ? parsed.data.CRON_SECRET : null;
}

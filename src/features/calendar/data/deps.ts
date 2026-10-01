import "server-only";

import { createGoogleCalendarProvider } from "@/features/calendar/providers/google";
import type {
  CalendarProvider,
  CalendarProviderId,
} from "@/features/calendar/providers/types";
import { secretKey, type SecretKey } from "@/lib/crypto/secret-box";
import { getCalendarEnv, type CalendarEnv } from "@/lib/env/server";
import { AppException } from "@/lib/errors";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Everything the calendar services need, resolved once per request. Fails
// closed: without complete configuration, nothing runs.

export type CalendarDeps = {
  env: CalendarEnv;
  /** Service-role client: the only one that can reach credentials and sync. */
  admin: AppSupabaseClient;
  provider: (id: CalendarProviderId) => CalendarProvider;
  /** Current key first, then former keys (decryption only). */
  keys: SecretKey[];
};

export function getCalendarDeps(): CalendarDeps {
  const env = getCalendarEnv();
  if (!env) throw new AppException("calendar_not_configured");

  const google = createGoogleCalendarProvider({
    clientId: env.GOOGLE_CALENDAR_CLIENT_ID,
    clientSecret: env.GOOGLE_CALENDAR_CLIENT_SECRET,
  });

  return {
    env,
    admin: createAdminSupabaseClient() as AppSupabaseClient,
    provider: () => google,
    keys: [
      secretKey(env.CALENDAR_TOKEN_ENCRYPTION_KEY),
      ...env.CALENDAR_TOKEN_PREVIOUS_KEYS.map(secretKey),
    ],
  };
}

/** Associated data binding token ciphertexts to their business. */
export const tokenAad = (businessId: string, provider: string) =>
  `calendar-token:${provider}:${businessId}`;

import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getPublicEnv } from "@/lib/env/public";
import {
  authOutageGuard,
  isSessionCookie,
} from "@/lib/supabase/session-cookies";
import type { Database } from "@/types/database.generated";

/**
 * Why the client is created:
 *   session   (default) everything that reads or uses her session. A
 *             deletion of her session cookies is applied only when Auth
 *             itself answered (signed out, refresh token refused, session
 *             revoked…), never because Auth could not be reached
 *             (src/lib/supabase/session-cookies.ts).
 *   sign_out  her own sign-out, which she asked for: every deletion is
 *             applied, and forgetSessionOnThisDevice() removes what an
 *             unreachable Auth left behind.
 */
export type ServerClientPurpose = "session" | "sign_out";

export async function createServerSupabaseClient(
  purpose: ServerClientPurpose = "session",
) {
  const cookieStore = await cookies();
  const env = getPublicEnv();
  const guard = purpose === "session" ? authOutageGuard() : null;

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      ...(guard ? { global: { fetch: guard.fetch } } : {}),
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            (guard ? guard.filter(cookiesToSet) : cookiesToSet).forEach(
              ({ name, value, options }) => {
                cookieStore.set(name, value, options);
              },
            );
          } catch {
            // Server Components cannot write cookies. src/proxy.ts refreshes
            // the session; Server Actions and Route Handlers can write them.
          }
        },
      },
    },
  );
}

/**
 * Deletes her session cookies on this device. Only for a sign-out she asked
 * for: when Auth cannot be reached, auth-js may keep them (a refresh it
 * retries); she still leaves this device signed out.
 */
export async function forgetSessionOnThisDevice() {
  const cookieStore = await cookies();
  const env = getPublicEnv();
  for (const { name } of cookieStore.getAll()) {
    if (isSessionCookie(name, env.NEXT_PUBLIC_SUPABASE_URL)) {
      cookieStore.set(name, "", { path: "/", maxAge: 0 });
    }
  }
}

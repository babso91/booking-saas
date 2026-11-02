import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { hasPublicSupabaseEnv } from "@/lib/env/public";
import { authFailureOf } from "@/lib/supabase/auth-errors";
import { deletesCookie } from "@/lib/supabase/session-cookies";

/** Routes that require a signed-in professional. Everything else is public. */
export function requiresSession(pathname: string) {
  return /^\/(app|onboarding)(\/|$)/.test(pathname);
}

type CookieWrite = {
  name: string;
  value: string;
  options: Parameters<NextResponse["cookies"]["set"]>[2];
};

export async function refreshSupabaseSession(request: NextRequest) {
  if (!hasPublicSupabaseEnv()) {
    return NextResponse.next({ request });
  }

  // The client's cookie writes are kept until the session is known: an
  // outage of Auth must never delete her session cookies.
  const original = new Map(
    request.cookies.getAll().map(({ name, value }) => [name, value]),
  );
  const writes: CookieWrite[] = [];
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach((write) => {
            request.cookies.set(write.name, write.value);
            writes.push(write);
          });
        },
      },
    },
  );

  // Validates and refreshes the auth token when needed. Authorization remains
  // the responsibility of the DAL and PostgreSQL RLS.
  const { data, error } = await supabase.auth.getClaims();
  const unavailable =
    !data?.claims?.sub &&
    error !== null &&
    authFailureOf(error) === "unavailable";

  // Auth unreachable: not a sign-out. Tokens it refreshed are kept, nothing
  // is deleted, and the request goes on to the guards, which refuse it with
  // a temporary error (/indisponible), and to the Server Actions, which
  // answer `auth_unavailable`. Nothing is let through on the strength of
  // this proxy: it never authorises anything.
  const applied = unavailable
    ? writes.filter((write) => !deletesCookie(write))
    : writes;
  if (unavailable) {
    // What the guards and actions read next: her cookies as they came.
    for (const write of writes.filter(deletesCookie)) {
      const value = original.get(write.name);
      if (value !== undefined) request.cookies.set(write.name, value);
    }
  }

  // Optimistic check only: private routes also verify the session and the
  // business state server-side (src/features/auth/data/guards.ts), and every
  // Server Action re-checks auth itself.
  if (
    !unavailable &&
    !data?.claims?.sub &&
    requiresSession(request.nextUrl.pathname)
  ) {
    const redirect = NextResponse.redirect(new URL("/login", request.url));

    // Keep cookie updates (e.g. clearing an expired session).
    applied.forEach(({ name, value, options }) =>
      redirect.cookies.set(name, value, options),
    );

    return redirect;
  }

  const response = NextResponse.next({ request });
  applied.forEach(({ name, value, options }) =>
    response.cookies.set(name, value, options),
  );
  return response;
}

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { hasPublicSupabaseEnv } from "@/lib/env/public";

/** Routes that require a signed-in professional. Everything else is public. */
export function requiresSession(pathname: string) {
  return /^\/(app|onboarding)(\/|$)/.test(pathname);
}

export async function refreshSupabaseSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  if (!hasPublicSupabaseEnv()) {
    return response;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });

          response = NextResponse.next({ request });

          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  // Validates and refreshes the auth token when needed. Authorization remains
  // the responsibility of the DAL and PostgreSQL RLS.
  const { data } = await supabase.auth.getClaims();

  // Optimistic check only: private routes also verify the session and the
  // business state server-side (src/features/auth/data/guards.ts), and every
  // Server Action re-checks auth itself.
  if (!data?.claims?.sub && requiresSession(request.nextUrl.pathname)) {
    const redirect = NextResponse.redirect(new URL("/login", request.url));

    // Keep cookie updates (e.g. clearing an expired session).
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));

    return redirect;
  }

  return response;
}

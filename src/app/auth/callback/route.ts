import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { safeNextPath } from "@/features/auth/data/redirects";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Landing point of Supabase Auth emails and redirects (sign-up confirmation
// today; magic link, password reset and OAuth providers later). It turns the
// one-time code into a session cookie, then hands over to the route guards.

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const next = safeNextPath(searchParams.get("next"));
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const supabase = await createServerSupabaseClient();
  let failed = true;

  if (code) {
    // PKCE flow: the code verifier cookie was set when the flow started.
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    failed = Boolean(error);
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });
    failed = Boolean(error);
  }

  const destination = failed ? "/login?error=auth_callback_failed" : next;

  // "/app" then redirects to /onboarding when no business exists yet.
  return NextResponse.redirect(new URL(destination, request.url));
}

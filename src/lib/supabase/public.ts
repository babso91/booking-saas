import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getPublicEnv } from "@/lib/env/public";
import type { Database } from "@/types/database.generated";

// Session-less client used by public Route Handlers and pages. It runs as the
// `anon` role, which has no table privilege: it can only call the narrow public
// RPCs (business by slug, active services, availability, booking).
export function createPublicSupabaseClient() {
  const env = getPublicEnv();

  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

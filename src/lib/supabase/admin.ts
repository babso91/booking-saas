import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getAdminEnv } from "@/lib/env/server";
import { getPublicEnv } from "@/lib/env/public";

export function createAdminSupabaseClient() {
  const publicEnv = getPublicEnv();
  const adminEnv = getAdminEnv();

  return createClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    adminEnv.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

import "server-only";

import { getPublicEnv } from "@/lib/env/public";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import { getEmailTransport } from "../transport";
import type { EmailWorkerDeps } from "./worker";

/** The worker's dependencies, or null when delivery is not configured. */
export function getEmailWorkerDeps(): EmailWorkerDeps | null {
  const configured = getEmailTransport();
  if (!configured) return null;
  return {
    admin: createAdminSupabaseClient() as AppSupabaseClient,
    transport: configured.transport,
    from: configured.from,
    appUrl: getPublicEnv().NEXT_PUBLIC_APP_URL,
  };
}

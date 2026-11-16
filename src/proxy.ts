import type { NextRequest } from "next/server";

import { domainRoutingEnabled } from "@/features/domains-server/config";
import { customHostResponse } from "@/features/domains-server/custom-host";
import { refreshSupabaseSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  // Her own domains (SITE_DOMAINS_ENABLED=true): her public page only.
  if (domainRoutingEnabled()) {
    const custom = await customHostResponse(request);
    if (custom) return custom;
  }
  return refreshSupabaseSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

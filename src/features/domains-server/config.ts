import "server-only";

import { getPublicEnv } from "@/lib/env/public";
import { AppException } from "@/lib/errors";

// Where her name must point (SITE_DOMAIN_TARGET, a hostname of ours) and
// her usual address. Without a target, custom domains are unavailable.
export function domainConfig(slug?: string) {
  const target = process.env.SITE_DOMAIN_TARGET?.trim().toLowerCase();
  if (!target || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(target)) {
    throw new AppException("domain_unavailable");
  }
  const origin = new URL(getPublicEnv().NEXT_PUBLIC_APP_URL).origin;
  return { target, fallback: slug ? `${origin}/b/${slug}` : origin };
}

/** Custom-domain routing is on only when asked (SITE_DOMAINS_ENABLED=true). */
export function domainRoutingEnabled() {
  return process.env.SITE_DOMAINS_ENABLED === "true";
}

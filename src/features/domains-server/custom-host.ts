import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import {
  canonicalHost,
  routeForHost,
} from "@/features/domains-server/route-cache";
import { getPublicEnv } from "@/lib/env/public";

// A request on one of her own names (docs/SITE_DOMAIN_CONTRACT.md): only her
// public page and what it needs are served there; never the professional
// space, never a server action, never a session cookie (the session is not
// even refreshed). null: the request is on one of our own hosts.

const ALLOWED_PREFIXES = ["/_next/", "/api/public/", "/api/unsubscribe/"];
const ALLOWED_PATHS = [
  "/api/bookings",
  "/api/domains/probe",
  "/desinscription",
];

/** Our hosts: the app's, plus SITE_PLATFORM_HOSTS (comma-separated). */
function platformHosts() {
  const hosts = new Set([
    canonicalHost(new URL(getPublicEnv().NEXT_PUBLIC_APP_URL).host),
  ]);
  for (const host of (process.env.SITE_PLATFORM_HOSTS ?? "").split(",")) {
    if (host.trim()) hosts.add(canonicalHost(host));
  }
  return hosts;
}

export async function customHostResponse(
  request: NextRequest,
): Promise<NextResponse | null> {
  const host = canonicalHost(request.headers.get("host") ?? "");
  if (!host || platformHosts().has(host)) return null;

  const route = await routeForHost(host);
  if (!route) return new NextResponse(null, { status: 404 });

  // No server action on her name (sign-in, sign-up, anything).
  if (request.headers.has("next-action")) {
    return new NextResponse(null, { status: 404 });
  }
  const { pathname } = request.nextUrl;
  if (pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = `/b/${route.slug}`;
    return NextResponse.rewrite(url);
  }
  if (
    pathname === `/b/${route.slug}` ||
    ALLOWED_PATHS.includes(pathname) ||
    ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return NextResponse.next();
  }
  return new NextResponse(null, { status: 404 });
}

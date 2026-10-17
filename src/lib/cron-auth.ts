import "server-only";

import { timingSafeEqual } from "node:crypto";

import { getCronSecret } from "@/lib/env/server";

/**
 * A scheduled job's request: `Authorization: Bearer $CRON_SECRET`, compared
 * in constant time. Without a configured secret, every call is refused.
 */
export function isAuthorizedCronRequest(request: Request) {
  const secret = getCronSecret();
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(request.headers.get("authorization") ?? "");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

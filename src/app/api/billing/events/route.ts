import { createHmac, timingSafeEqual } from "node:crypto";

import { billingEventSchema } from "@/features/platform-billing/schemas";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// POST /api/billing/events — billing events, normalised by the provider
// adapter (docs/PLATFORM_BILLING_CONTRACT.md). Authenticated by an HMAC of
// the raw body: `X-Billing-Signature: sha256=<hex>` with
// BILLING_WEBHOOK_SECRET. Without the secret, every event is refused (no
// provider connected). The event is recorded once (by eventId) before the
// acknowledgement: a redelivery is a neutral duplicate.
// 200 { outcome }; 400 invalid; 401 bad signature; 503 not configured or
// storage unavailable (the provider retries).
export const dynamic = "force-dynamic";

function verified(raw: string, signature: string | null, secret: string) {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(raw, "utf8").digest("hex"),
  );
  const received = Buffer.from(signature.slice("sha256=".length));
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export async function POST(request: Request) {
  const secret = process.env.BILLING_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }
  const raw = await request.text();
  if (!verified(raw, request.headers.get("x-billing-signature"), secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  const parsed = billingEventSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  const service = createAdminSupabaseClient() as AppSupabaseClient;
  const { data, error } = await service.rpc("platform_ingest_event", {
    p_event: parsed.data,
  });
  if (error) {
    console.error("Billing event not stored.");
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
  return Response.json({ outcome: data });
}

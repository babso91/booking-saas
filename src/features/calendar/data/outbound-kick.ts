import "server-only";

import { getCalendarEnv } from "@/lib/env/server";

import { runAfterResponse } from "./background";
import { getCalendarDeps } from "./deps";
import { processOutbound } from "./outbound";

/**
 * Best-effort: after an appointment change was committed and the response
 * sent, applies the business's due mirrors. Never part of the request: a
 * provider failure or a missing configuration cannot reach the booking. The
 * periodic job is the durable catch-up.
 */
export function kickCalendarOutbound(
  target: { businessId: string } | { appointmentId: string },
) {
  if (!getCalendarEnv()) return;
  runAfterResponse("outbound_kick", async () => {
    const deps = getCalendarDeps();
    let businessId: string | undefined;
    if ("businessId" in target) {
      businessId = target.businessId;
    } else {
      const { data } = await deps.admin
        .from("appointments")
        .select("business_id")
        .eq("id", target.appointmentId)
        .maybeSingle();
      businessId = data?.business_id;
    }
    if (businessId)
      await processOutbound(deps, { businessId, budgetMs: 15_000 });
  });
}

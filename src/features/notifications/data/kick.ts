import "server-only";

import { after } from "next/server";

import { getEmailWorkerDeps } from "./deps";
import { logEmail } from "./log";
import { runEmailOutbox } from "./worker";

/**
 * Best-effort: after a booking or an agenda change was committed and
 * answered, delivers a small batch of that business's due emails, so a
 * confirmation does not wait for the periodic job. Never part of the
 * request: a provider failure or a missing configuration cannot reach the
 * booking. The periodic job (/api/cron/emails) is the durable path.
 */
export function kickEmailOutbox(
  target: { businessId: string } | { appointmentId: string },
) {
  const deps = getEmailWorkerDeps();
  if (!deps) return;
  after(async () => {
    try {
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
      if (businessId) {
        await runEmailOutbox(deps, { businessId, limit: 5, budgetMs: 15_000 });
      }
    } catch {
      logEmail("kick_failed", { transport: deps.transport.name }, "error");
    }
  });
}

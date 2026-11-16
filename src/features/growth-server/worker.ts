import "server-only";

import { randomBytes } from "node:crypto";

import { hashUnsubscribeToken } from "@/features/marketing-consent/data";
import type {
  MarketingTransport,
  SendOutcome,
} from "@/features/growth-server/transport";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// The marketing queue's worker (docs/GROWTH_CAMPAIGNS_CONTRACT.md): claim,
// authorize under her consent lock, send outside any transaction, report
// with the same fence; then reconcile uncertain deliveries by their key.
// Its own queue and cron: never in the way of appointment emails.

const SEND_TIMEOUT_MS = 5_000;
/** Stops handing off well before the route's 60 s limit; claims left lapse. */
const RUN_BUDGET_MS = 35_000;

type Authorized = {
  outcome: "send";
  deliveryKey: string;
  channel: "email" | "sms";
  recipient: string;
  firstName: string;
  businessName: string;
  message: string;
  units: number;
};

export type GrowthRunResult = {
  claimed: number;
  sent: number;
  suppressed: number;
  uncertain: number;
  reconciled: number;
};

function render(item: Authorized, token: string, appUrl: string) {
  const origin = new URL(appUrl).origin;
  const page = `${origin}/desinscription#t=${token}`;
  if (item.channel === "sms") return { text: item.message };
  return {
    subject: `Un message de ${item.businessName}`,
    text: `${item.message}\n\n—\nNe plus recevoir les offres de ${item.businessName} : ${page}`,
    headers: {
      "List-Unsubscribe": `<${origin}/api/unsubscribe/${token}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

async function report(
  service: AppSupabaseClient,
  occurrenceId: string,
  fence: number,
  result: SendOutcome | { outcome: "transient" },
): Promise<string> {
  const { data, error } = await service.rpc("growth_report", {
    p_occurrence_id: occurrenceId,
    p_fence: fence,
    p_outcome: result.outcome,
    p_provider_ref:
      result.outcome === "accepted" ? result.providerRef : undefined,
    p_actual_units:
      result.outcome === "accepted" ? result.actualUnits : undefined,
  });
  if (error) throw databaseException(error);
  return data;
}

export async function runGrowthQueue(deps: {
  service: AppSupabaseClient;
  transport: MarketingTransport;
  appUrl: string;
  limit?: number;
}): Promise<GrowthRunResult> {
  const { service, transport } = deps;
  const result: GrowthRunResult = {
    claimed: 0,
    sent: 0,
    suppressed: 0,
    uncertain: 0,
    reconciled: 0,
  };

  const claimed = await service.rpc("growth_claim", {
    p_limit: deps.limit ?? 20,
    p_lease_seconds: 60,
  });
  if (claimed.error) throw databaseException(claimed.error);
  result.claimed = claimed.data.length;

  const deadline = Date.now() + RUN_BUDGET_MS;
  for (const { occurrence_id: id, fence } of claimed.data) {
    // Past the deadline, the rest stay claimed: their lease lapses and the
    // next run takes them (nothing was handed off).
    if (Date.now() > deadline) break;
    const token = `uns_${randomBytes(32).toString("base64url")}`;
    const authorized = await service.rpc("growth_authorize", {
      p_occurrence_id: id,
      p_fence: fence,
      p_unsubscribe_token_hash: hashUnsubscribeToken(token),
    });
    if (authorized.error) throw databaseException(authorized.error);
    const item = authorized.data as unknown as
      Authorized | { outcome: "suppressed" | "deferred" | "closed" | "stale" };
    if (item.outcome !== "send") {
      if (item.outcome === "suppressed") result.suppressed += 1;
      continue;
    }

    let outcome: SendOutcome;
    try {
      outcome = await transport.send(
        {
          deliveryKey: item.deliveryKey,
          channel: item.channel,
          recipient: item.recipient,
          rendered: render(item, token, deps.appUrl),
          maxUnits: item.units,
        },
        AbortSignal.timeout(SEND_TIMEOUT_MS),
      );
    } catch {
      // Handed off, answer lost: never resent before reconciliation.
      outcome = { outcome: "unknown" };
    }
    const status = await report(service, id, fence, outcome);
    if (status === "accepted") result.sent += 1;
    if (status === "uncertain") result.uncertain += 1;
  }

  const uncertain = await service.rpc("growth_uncertain", { p_limit: 25 });
  if (uncertain.error) throw databaseException(uncertain.error);
  for (const { occurrence_id: id, fence } of uncertain.data) {
    const found = await transport.lookup(id);
    if (found.outcome === "unknown") continue;
    await report(
      service,
      id,
      fence,
      found.outcome === "not_found" ? { outcome: "transient" } : found,
    );
    result.reconciled += 1;
  }
  return result;
}

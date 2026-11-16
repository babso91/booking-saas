"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  cancelScheduledSchema,
  cancellationSchema,
  confirmChangeSchema,
  quoteChangeSchema,
} from "@/features/platform-billing/schemas";
import { AppException, toAppError, type ActionResult } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Her SaaS plan and billing (docs/PLATFORM_BILLING_CONTRACT.md). Simulated:
// no payment provider is connected, nothing is charged, and no right moves
// without a verified payment event. Members read; the owner acts.

type Dto = Record<string, unknown>;

async function rpc(client: AppSupabaseClient, fn: string, args: object) {
  const { data, error } = await (
    client.rpc as unknown as (
      f: string,
      a: object,
    ) => Promise<{
      data: unknown;
      error: Parameters<typeof databaseException>[0] | null;
    }>
  )(fn, args);
  if (error) throw databaseException(error);
  return data as Dto;
}

/** The offers on sale (also for the public pricing page). */
export async function listOffersAction(): Promise<ActionResult<Dto>> {
  try {
    const client = await createServerSupabaseClient();
    return { ok: true, data: await rpc(client, "platform_list_offers", {}) };
  } catch (error) {
    if (!(error instanceof AppException) || error.code === "internal") {
      console.error("Offers failed", error);
    }
    return { ok: false, error: toAppError(error) };
  }
}

export async function getBillingSummaryAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    rpc(client, "platform_billing_summary", { p_business_id: businessId }),
  );
}

export async function quotePlanChangeAction(input: unknown) {
  return runBusinessAction(
    quoteChangeSchema,
    input,
    ({ client, businessId }, data) =>
      rpc(client, "platform_quote_change", {
        p_business_id: businessId,
        p_target_plan: data.targetPlan,
        p_target_cadence: data.targetCadence,
        p_expected_revision: data.expectedSubscriptionRevision,
        p_promo_code: data.promoCode ?? null,
      }),
  );
}

export async function confirmPlanChangeAction(input: unknown) {
  const result = await runBusinessAction(
    confirmChangeSchema,
    input,
    ({ client, businessId }, data) =>
      rpc(client, "platform_confirm_change", {
        p_business_id: businessId,
        p_quote_id: data.quoteId,
        p_expected_revision: data.expectedRevision,
        p_operation_id: data.operationId,
      }),
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

export async function cancelScheduledChangeAction(input: unknown) {
  const result = await runBusinessAction(
    cancelScheduledSchema,
    input,
    ({ client, businessId }, data) =>
      rpc(client, "platform_cancel_scheduled", {
        p_business_id: businessId,
        p_command_id: data.commandId,
        p_operation_id: data.operationId,
      }),
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

export async function requestCancellationAction(input: unknown) {
  const result = await runBusinessAction(
    cancellationSchema,
    input,
    ({ client, businessId }, data) =>
      rpc(client, "platform_request_cancellation", {
        p_business_id: businessId,
        p_expected_revision: data.expectedRevision,
        p_operation_id: data.operationId,
      }),
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

export async function undoCancellationAction(input: unknown) {
  const result = await runBusinessAction(
    cancellationSchema,
    input,
    ({ client, businessId }, data) =>
      rpc(client, "platform_undo_cancellation", {
        p_business_id: businessId,
        p_expected_revision: data.expectedRevision,
        p_operation_id: data.operationId,
      }),
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

export async function listInvoicesAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    rpc(client, "platform_list_invoices", { p_business_id: businessId }),
  );
}

/** No provider portal while simulated. */
export async function openBillingPortalAction(): Promise<
  ActionResult<{ url: string }>
> {
  return {
    ok: false,
    error: toAppError(new AppException("billing_unavailable")),
  };
}

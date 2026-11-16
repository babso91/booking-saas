"use server";

import { revalidatePath } from "next/cache";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  getClientConsentHistory,
  getClientConsents,
  setConsent,
  unsubscribe,
  type UnsubscribeView,
} from "@/features/marketing-consent/data";
import {
  clientConsentsSchema,
  setConsentSchema,
  unsubscribeTokenSchema,
} from "@/features/marketing-consent/schemas";
import { AppException, toAppError, type ActionResult } from "@/lib/errors";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Marketing consent (docs/MARKETING_CONSENT_CONTRACT.md). The professional's
// actions run under her session; the unsubscribe page's need no login: the
// link's token alone proves the business, customer and channel.

/** A customer's marketing consent, per channel (CRM profile). */
export async function getClientConsentsAction(input: unknown) {
  return runBusinessAction(
    clientConsentsSchema,
    input,
    ({ client, businessId }, { clientId }) =>
      getClientConsents(client, businessId, clientId),
  );
}

/** Her register for this business, newest first (every change, never erased). */
export async function getClientConsentHistoryAction(input: unknown) {
  return runBusinessAction(
    clientConsentsSchema,
    input,
    ({ client, businessId }, { clientId }) =>
      getClientConsentHistory(client, businessId, clientId),
  );
}

/**
 * She agreed (`grant`, with `proofVersion`: the wording she was shown) or
 * refused (`withdraw`), as told to the professional. Idempotent by
 * `requestId`. A grant needs a wording validated on the server
 * (`consent_wording_not_validated` otherwise; none is yet).
 */
export async function setConsentAction(input: unknown) {
  const result = await runBusinessAction(
    setConsentSchema,
    input,
    ({ client, businessId }, data) => setConsent(client, businessId, data),
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

async function runUnsubscribe(
  fn: "unsubscribe_read" | "unsubscribe_withdraw" | "unsubscribe_undo",
  token: unknown,
): Promise<ActionResult<UnsubscribeView>> {
  try {
    const parsed = unsubscribeTokenSchema.safeParse(token);
    if (!parsed.success) throw new AppException("unsubscribe_link_invalid");
    const service = createAdminSupabaseClient() as AppSupabaseClient;
    return { ok: true, data: await unsubscribe(service, fn, parsed.data) };
  } catch (error) {
    if (!(error instanceof AppException) || error.code === "internal") {
      console.error("Unsubscribe failed", error);
    }
    return { ok: false, error: toAppError(error) };
  }
}

/** What the link is for; changes nothing (link previews open links). */
export async function readUnsubscribeAction(token: unknown) {
  return runUnsubscribe("unsubscribe_read", token);
}

/** Her click: no more marketing from this business on this channel. Idempotent. */
export async function withdrawUnsubscribeAction(token: unknown) {
  return runUnsubscribe("unsubscribe_withdraw", token);
}

/**
 * Undo within 30 minutes of her withdrawal through this link (a click by
 * mistake): the state before comes back. `unsubscribe_undo_unavailable`
 * otherwise.
 */
export async function resubscribeUnsubscribeAction(token: unknown) {
  return runUnsubscribe("unsubscribe_undo", token);
}

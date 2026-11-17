"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  confirmConsent,
  isConfirmationToken,
  readConsentConfirmation,
  getConsentTexts,
  type ConsentNoticeDto,
  type ConsentTextsDto,
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
import { databaseException } from "@/lib/supabase/errors";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
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
 * She refused (`withdraw`), as told to the professional. Idempotent by
 * `requestId`. `grant` is refused (`consent_direct_only`): only the customer
 * herself agrees (her booking).
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

/**
 * For the booking page: the active texts and whether collection is on (off:
 * no box at all). No login.
 */
export async function getConsentTextsAction(): Promise<
  ActionResult<ConsentTextsDto>
> {
  try {
    return {
      ok: true,
      data: await getConsentTexts(createPublicSupabaseClient()),
    };
  } catch (error) {
    return { ok: false, error: toAppError(error) };
  }
}

/** For the booking page's notice: the business's details, and what is missing. */
export async function getConsentNoticeAction(
  slug: unknown,
): Promise<ActionResult<ConsentNoticeDto>> {
  try {
    if (typeof slug !== "string" || slug.length > 100) {
      throw new AppException("business_not_found");
    }
    const { data, error } = await createPublicSupabaseClient().rpc(
      "consent_notice",
      {
        p_slug: slug,
      },
    );
    if (error) throw databaseException(error);
    if (!data) throw new AppException("business_not_found");
    return { ok: true, data: data as unknown as ConsentNoticeDto };
  } catch (error) {
    return { ok: false, error: toAppError(error) };
  }
}

const legalProfileSchema = z.object({
  legalName: z.string().trim().max(200).nullable(),
  address: z.string().trim().max(500).nullable(),
  contactEmail: z.string().trim().max(254).nullable(),
  registrationNumber: z.string().trim().max(50).nullable(),
});

/** Her business's details for the notice (any member reads). */
export async function getBusinessLegalProfileAction() {
  return runBusinessAction(
    z.undefined(),
    undefined,
    async ({ client, businessId }) => {
      const { data, error } = await client.rpc("business_legal_profile", {
        p_business_id: businessId,
      });
      if (error) throw databaseException(error);
      return data as unknown as ConsentNoticeDto;
    },
  );
}

/** The owner fills them; null clears a field. */
export async function setBusinessLegalProfileAction(input: unknown) {
  const result = await runBusinessAction(
    legalProfileSchema,
    input,
    async ({ client, businessId }, data) => {
      const { data: profile, error } = await client.rpc(
        "set_business_legal_profile",
        {
          p_business_id: businessId,
          p_legal_name: data.legalName as string,
          p_address: data.address as string,
          p_contact_email: data.contactEmail as string,
          p_registration_number: data.registrationNumber as string,
        },
      );
      if (error) throw databaseException(error);
      return profile as unknown as ConsentNoticeDto;
    },
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

/** The confirmation page, before her click (no login; changes nothing). */
export async function readConsentConfirmationAction(token: unknown) {
  try {
    if (!isConfirmationToken(token))
      throw new AppException("consent_link_invalid");
    const service = createAdminSupabaseClient() as AppSupabaseClient;
    return {
      ok: true as const,
      data: await readConsentConfirmation(service, token),
    };
  } catch (error) {
    return { ok: false as const, error: toAppError(error) };
  }
}

/** Her click: her agreement is recorded now (double opt-in). */
export async function confirmConsentAction(token: unknown) {
  try {
    if (!isConfirmationToken(token))
      throw new AppException("consent_link_invalid");
    const service = createAdminSupabaseClient() as AppSupabaseClient;
    return { ok: true as const, data: await confirmConsent(service, token) };
  } catch (error) {
    if (!(error instanceof AppException) || error.code === "internal") {
      console.error("Consent confirmation failed", error);
    }
    return { ok: false as const, error: toAppError(error) };
  }
}

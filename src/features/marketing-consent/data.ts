import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type {
  ConsentChannel,
  SetConsentInput,
} from "@/features/marketing-consent/schemas";
import { getPublicEnv } from "@/lib/env/public";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Marketing consent (docs/MARKETING_CONSENT_CONTRACT.md): an append-only
// register per customer × purpose × channel, read and changed by database
// functions only. Appointment emails never read it: they are not marketing.

export type ConsentState = "unknown" | "granted" | "withdrawn";

export type ConsentDto = {
  purpose: "marketing";
  channel: ConsentChannel;
  state: ConsentState;
  proofVersion: string | null;
  source: "professional" | "unsubscribe_link" | "unsubscribe_undo" | null;
  changedAt: string | null;
};

export type UnsubscribeView = {
  businessName: string;
  channel: ConsentChannel;
  alreadyWithdrawn: boolean;
  /** The minutes after her withdrawal through this link: undo is possible. */
  canUndo: boolean;
};

export async function getClientConsents(
  client: AppSupabaseClient,
  businessId: string,
  clientId: string,
): Promise<ConsentDto[]> {
  const { data, error } = await client.rpc("marketing_client_consents", {
    p_business_id: businessId,
    p_client_id: clientId,
  });
  if (error) throw databaseException(error);
  return data as unknown as ConsentDto[];
}

export type ConsentEventDto = {
  purpose: "marketing";
  channel: ConsentChannel;
  state: ConsentState;
  proofVersion: string | null;
  source: NonNullable<ConsentDto["source"]>;
  businessName: string;
  occurredAt: string;
};

export async function getClientConsentHistory(
  client: AppSupabaseClient,
  businessId: string,
  clientId: string,
): Promise<ConsentEventDto[]> {
  const { data, error } = await client.rpc("marketing_client_consent_history", {
    p_business_id: businessId,
    p_client_id: clientId,
  });
  if (error) throw databaseException(error);
  return data as unknown as ConsentEventDto[];
}

export async function setConsent(
  client: AppSupabaseClient,
  businessId: string,
  input: SetConsentInput,
): Promise<ConsentDto> {
  const { data, error } = await client.rpc("marketing_set_consent", {
    p_business_id: businessId,
    p_client_id: input.clientId,
    p_purpose: input.purpose,
    p_channel: input.channel,
    p_action: input.action,
    // null when withdrawing: the database ignores it then.
    p_proof_version: (input.proofVersion ?? null) as string,
    p_request_id: input.requestId,
  });
  if (error) throw databaseException(error);
  return data as unknown as ConsentDto;
}

export function hashUnsubscribeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * A link for one marketing message to this customer on this channel (the
 * service only). `pageUrl` goes in the message (its token in the fragment:
 * never sent to the server by the browser, nor in the referrer);
 * `oneClickUrl` in the `List-Unsubscribe` header (RFC 8058).
 */
export async function issueUnsubscribeLink(
  service: AppSupabaseClient,
  input: { businessId: string; clientId: string; channel: ConsentChannel },
): Promise<{ token: string; pageUrl: string; oneClickUrl: string }> {
  const token = `uns_${randomBytes(32).toString("base64url")}`;
  const { error } = await service.rpc("issue_unsubscribe_link", {
    p_business_id: input.businessId,
    p_client_id: input.clientId,
    p_channel: input.channel,
    p_token_hash: hashUnsubscribeToken(token),
  });
  if (error) throw databaseException(error);
  const origin = new URL(getPublicEnv().NEXT_PUBLIC_APP_URL).origin;
  return {
    token,
    pageUrl: `${origin}/desinscription#t=${token}`,
    oneClickUrl: `${origin}/api/unsubscribe/${token}`,
  };
}

type UnsubscribeFn =
  "unsubscribe_read" | "unsubscribe_withdraw" | "unsubscribe_undo";

export async function unsubscribe(
  service: AppSupabaseClient,
  fn: UnsubscribeFn,
  token: string,
): Promise<UnsubscribeView> {
  const { data, error } = await service.rpc(fn, {
    p_token_hash: hashUnsubscribeToken(token),
  });
  if (error) throw databaseException(error);
  return data as unknown as UnsubscribeView;
}

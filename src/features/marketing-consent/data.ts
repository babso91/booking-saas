import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { sendConsentConfirmation } from "@/features/marketing-consent/confirmation-email";
import { getEmailTransport } from "@/features/notifications/transport";

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
  /**
   * Her agreement was for another address or number than the record's now:
   * it no longer counts (state "unknown") until she agrees again.
   */
  destinationChanged: boolean;
  proofVersion: string | null;
  source:
    | "booking"
    | "client_hub"
    | "professional"
    | "unsubscribe_link"
    | "unsubscribe_undo"
    | null;
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

export type ConsentTextsDto = {
  /** Off: show no marketing box at all. */
  collectionEnabled: boolean;
  texts: Partial<
    Record<
      "email" | "sms" | "information" | "notice",
      { version: string; body: string }
    >
  >;
};

export async function getConsentTexts(
  client: AppSupabaseClient,
): Promise<ConsentTextsDto> {
  const { data, error } = await client.rpc("consent_texts_current");
  if (error) throw databaseException(error);
  return data as unknown as ConsentTextsDto;
}

export type ConsentNoticeDto = {
  businessName: string;
  controller: {
    legalName: string | null;
    address: string | null;
    contactEmail: string | null;
    registrationNumber: string | null;
  };
  /** The details the notice still needs (never invented). */
  missing: string[];
};

export type BookingConsentOutcome = {
  /**
   * pending: a confirmation link went to her address; her agreement counts
   * only once she clicks it. Otherwise why nothing waits.
   */
  status:
    | "pending"
    | "already_requested"
    | "collection_off"
    | "text_not_active"
    | "nothing_ticked"
    | "unreachable"
    | "unknown_booking"
    | "email_unavailable"
    | "failed";
};

const CONFIRMATION_TOKEN = /^cnf_[A-Za-z0-9_-]{43}$/;
export const isConfirmationToken = (value: unknown): value is string =>
  typeof value === "string" && CONFIRMATION_TOKEN.test(value);

/**
 * Her ticked boxes, after her booking (never failing it): pending until she
 * confirms from the link sent to the record's address (double opt-in).
 */
export async function requestBookingConsent(
  service: AppSupabaseClient,
  appointmentId: string,
  choice: {
    email?: boolean;
    sms?: boolean;
    versions: {
      email?: string;
      sms?: string;
      information: string;
      notice: string;
    };
  },
): Promise<BookingConsentOutcome> {
  const channels: Record<string, string> = {};
  for (const channel of ["email", "sms"] as const) {
    const version = choice.versions[channel];
    if (choice[channel] === true && version) channels[channel] = version;
  }
  if (Object.keys(channels).length === 0) return { status: "nothing_ticked" };
  const transport = getEmailTransport();
  if (!transport) return { status: "email_unavailable" };

  const token = `cnf_${randomBytes(32).toString("base64url")}`;
  const { data, error } = await service.rpc("consent_request_from_booking", {
    p_appointment_id: appointmentId,
    p_channels: channels,
    p_information_version: choice.versions.information,
    p_notice_version: choice.versions.notice,
    p_token_hash: hashUnsubscribeToken(token),
  });
  if (error) {
    console.error("Booking consent request not recorded.");
    return { status: "failed" };
  }
  const answer = data as unknown as {
    status: BookingConsentOutcome["status"];
    email?: string;
    businessName?: string;
  };
  if (answer.status !== "pending") return { status: answer.status };
  try {
    await sendConsentConfirmation(transport, {
      to: answer.email!,
      businessName: answer.businessName!,
      token,
      channels: Object.keys(channels) as ConsentChannel[],
    });
  } catch {
    // Never logs the address or the link. Not marked sent: a retry of the
    // same booking sends a new link (the former one stops working).
    console.error("Consent confirmation email could not be sent.");
    return { status: "email_unavailable" };
  }
  const { error: markError } = await service.rpc("consent_confirmation_sent", {
    p_token_hash: hashUnsubscribeToken(token),
  });
  if (markError) console.error("Consent confirmation not marked sent.");
  return { status: "pending" };
}

/** The confirmation page: what she is about to confirm (changes nothing). */
export async function readConsentConfirmation(
  service: AppSupabaseClient,
  token: string,
) {
  const { data, error } = await service.rpc("consent_confirmation_read", {
    p_token_hash: hashUnsubscribeToken(token),
  });
  if (error) throw databaseException(error);
  return data as unknown as {
    businessName: string;
    channels: ConsentChannel[];
    texts: Record<string, string>;
    confirmed: boolean;
  };
}

/** Her click: each ticked box becomes her agreement, with its proof. */
export async function confirmConsent(
  service: AppSupabaseClient,
  token: string,
) {
  const { data, error } = await service.rpc("consent_confirm", {
    p_token_hash: hashUnsubscribeToken(token),
  });
  if (error) throw databaseException(error);
  return data as unknown as {
    status: "confirmed" | "already_confirmed" | "collection_off";
    businessName: string;
    channels?: Partial<Record<ConsentChannel, "granted" | "unreachable">>;
  };
}

import "server-only";

import { encodeAppointmentCursor } from "@/features/client-hub/schemas/client-hub";
import type {
  ClientHubAccessDto,
  ClientHubAppointmentDetailDto,
  ClientHubAppointmentDto,
  ClientHubAppointmentsPageDto,
  ClientHubLedgerEntryDto,
  ClientHubLedgerPageDto,
  ClientHubLoyaltyDto,
  ClientHubProfileDto,
} from "@/features/client-hub/types";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Client Hub data access. Customer functions run with the service role
// (`admin`): they are executable by it only, and each one authenticates the
// session token and authorizes the business relationship itself, in
// PostgreSQL. Nothing here trusts an identifier for authorization: the
// business and appointment ids only select within what the session may see.

type Admin = AppSupabaseClient;

/** Issues a login code (returned once, to be emailed). */
export async function requestLoginCode(
  admin: Admin,
  email: string,
  clientIp: string,
) {
  const { data, error } = await admin
    .rpc("client_hub_request_code", { p_email: email, p_client_ip: clientIp })
    .single();
  if (error) throw databaseException(error);
  return {
    challengeId: data.challenge_id,
    code: data.code,
    /** The canonical address the challenge is bound to: send only there. */
    email: data.email,
    expiresAt: data.expires_at,
  };
}

/** The browser's session cookies, as presented to PostgreSQL. */
type Presented = { sessions: string[]; tokens: string[] };

/**
 * Verifies a code and opens a session; the sessions the browser presented
 * are ended (signing in replaces who the browser is). A refused code ends
 * nothing.
 */
export async function signIn(
  admin: Admin,
  input: { challengeId: string; email: string; code: string },
  clientIp: string,
  presented: Presented,
) {
  const { data, error } = await admin
    .rpc("client_hub_sign_in", {
      p_challenge_id: input.challengeId,
      p_email: input.email,
      p_code: input.code,
      p_client_ip: clientIp,
      p_sessions: presented.sessions,
      p_tokens: presented.tokens,
    })
    .single();
  if (error) throw databaseException(error);
  if (data.status === "rate_limited") throw new AppException("rate_limited");
  if (data.status !== "ok") {
    throw new AppException("client_hub_code_invalid", {
      fieldErrors: { code: ["Ce code n’est pas valable."] },
    });
  }
  return {
    sessionId: data.session_id!,
    token: data.session_token!,
    accountId: data.account_id!,
    email: data.email!,
    expiresAt: data.expires_at!,
  };
}

/**
 * The session the request acts as, among those presented: `ok` (the other
 * live sessions of its account are ended), `none`, or `conflict` (live
 * sessions of several accounts: all ended, none chosen).
 */
export async function resolveSession(
  admin: Admin,
  presented: Presented,
): Promise<
  | { status: "ok"; sessionId: string; token: string; accountId: string }
  | { status: "none" | "conflict" }
> {
  const { data, error } = await admin
    .rpc("client_hub_resolve_session", {
      p_sessions: presented.sessions,
      p_tokens: presented.tokens,
    })
    .single();
  if (error) throw databaseException(error);
  if (data.status === "ok") {
    return {
      status: "ok",
      sessionId: data.session_id,
      token: data.session_token,
      accountId: data.account_id,
    };
  }
  if (data.status === "none" || data.status === "conflict") {
    return { status: data.status };
  }
  throw new AppException("internal");
}

/** Ends the presented sessions (or every session of their accounts). */
export async function signOut(
  admin: Admin,
  presented: Presented,
  all: boolean,
) {
  const { error } = await admin.rpc("client_hub_sign_out", {
    p_sessions: presented.sessions,
    p_tokens: presented.tokens,
    p_all: all,
  });
  if (error) throw databaseException(error);
}

export async function getProfile(
  admin: Admin,
  token: string,
): Promise<ClientHubProfileDto> {
  const { data, error } = await admin.rpc("client_hub_profile", {
    p_session_token: token,
  });
  if (error) throw databaseException(error);
  return data as unknown as ClientHubProfileDto;
}

export async function listAppointments(
  admin: Admin,
  token: string,
  businessId: string,
  query: {
    scope: "upcoming" | "past";
    cursor?: { startsAt: string; id: string };
    limit: number;
  },
): Promise<ClientHubAppointmentsPageDto> {
  const { data, error } = await admin.rpc("client_hub_appointments", {
    p_session_token: token,
    p_business_id: businessId,
    p_scope: query.scope,
    p_after_starts_at: query.cursor?.startsAt,
    p_after_id: query.cursor?.id,
    p_limit: query.limit,
  });
  if (error) throw databaseException(error);
  const page = data as unknown as {
    items: ClientHubAppointmentDto[];
    hasMore: boolean;
  };
  const last = page.items[page.items.length - 1];
  return {
    items: page.items,
    nextCursor:
      page.hasMore && last
        ? encodeAppointmentCursor(last.startsAt, last.id)
        : null,
  };
}

export async function getAppointment(
  admin: Admin,
  token: string,
  businessId: string,
  appointmentId: string,
): Promise<ClientHubAppointmentDetailDto> {
  const { data, error } = await admin.rpc("client_hub_appointment", {
    p_session_token: token,
    p_business_id: businessId,
    p_appointment_id: appointmentId,
  });
  if (error) throw databaseException(error);
  return data as unknown as ClientHubAppointmentDetailDto;
}

export async function getLoyalty(
  admin: Admin,
  token: string,
  businessId: string,
): Promise<ClientHubLoyaltyDto> {
  const { data, error } = await admin.rpc("client_hub_loyalty", {
    p_session_token: token,
    p_business_id: businessId,
  });
  if (error) throw databaseException(error);
  return data as unknown as ClientHubLoyaltyDto;
}

export async function listLedger(
  admin: Admin,
  token: string,
  businessId: string,
  query: { cursor?: string; limit: number },
): Promise<ClientHubLedgerPageDto> {
  const { data, error } = await admin.rpc("client_hub_loyalty_ledger", {
    p_session_token: token,
    p_business_id: businessId,
    p_before_position:
      query.cursor === undefined ? undefined : Number(query.cursor),
    p_limit: query.limit,
  });
  if (error) throw databaseException(error);
  const page = data as unknown as {
    items: (ClientHubLedgerEntryDto & { position: number })[];
    hasMore: boolean;
  };
  const last = page.items[page.items.length - 1];
  return {
    items: page.items.map(({ position: _position, ...entry }) => entry),
    nextCursor: page.hasMore && last ? String(last.position) : null,
  };
}

// ---------------------------------------------------------------------------
// Professional side (the user's session, membership checked in SQL)
// ---------------------------------------------------------------------------

export async function getClientHubAccess(
  client: AppSupabaseClient,
  businessId: string,
  clientId: string,
): Promise<ClientHubAccessDto> {
  const [access, record] = await Promise.all([
    client
      .from("client_hub_access")
      .select("email, granted_at, revoked_at")
      .eq("business_id", businessId)
      .eq("client_id", clientId)
      .maybeSingle(),
    client
      .from("clients")
      .select("id")
      .eq("business_id", businessId)
      .eq("id", clientId)
      .maybeSingle(),
  ]);
  if (access.error) throw databaseException(access.error);
  if (record.error) throw databaseException(record.error);
  if (!record.data) throw new AppException("client_not_found");

  // A change of the record's email revokes the access (database trigger).
  const active = access.data && access.data.revoked_at === null;
  return {
    clientId,
    granted: Boolean(active),
    email: active ? access.data!.email : null,
    grantedAt: active ? access.data!.granted_at : null,
  };
}

export async function setClientHubAccess(
  client: AppSupabaseClient,
  businessId: string,
  input: { clientId: string; granted: boolean; expectedEmail?: string },
): Promise<ClientHubAccessDto> {
  const { error } = await client.rpc("client_hub_set_access", {
    p_business_id: businessId,
    p_client_id: input.clientId,
    p_granted: input.granted,
    p_expected_email: input.expectedEmail,
  });
  if (error) throw databaseException(error);
  return getClientHubAccess(client, businessId, input.clientId);
}

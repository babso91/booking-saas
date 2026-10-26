import type {
  ClientHubAppointmentDetailDto,
  ClientHubAppointmentsPageDto,
  ClientHubLedgerPageDto,
  ClientHubLoyaltyDto,
  ClientHubProfileDto,
} from "@/features/client-hub/types";
import type { AppErrorCode } from "@/lib/errors";

// The Client Hub routes (docs/CLIENT_HUB_CONTRACT.md), called from the
// browser. The session is an HttpOnly __Host- cookie: the browser attaches
// it to these same-origin requests, no script ever sees it, and only these
// routes read it (no page renders anything from it). Never throws: every
// outcome is a
// result. `network` means no readable answer (offline, timeout, cut
// connection, a page that is not our JSON).

export type HubErrorCode = AppErrorCode | "network";

export type HubError = {
  code: HubErrorCode;
  fieldErrors?: Record<string, string[]>;
};

/**
 * `account`: the account the server says the answer was served for
 * (X-Client-Hub-Account), null when it names none. A private answer is
 * shown only for the account the page confirmed (client/session.tsx).
 */
export type HubResult<T> =
  | { ok: true; data: T; account: string | null }
  | { ok: false; error: HubError; account: string | null };

/** Longest wait for an answer before saying so. */
export const HUB_TIMEOUT_MS = 15_000;

async function request<T>(
  url: string,
  init: RequestInit,
): Promise<HubResult<T>> {
  const controller = new AbortController();
  const outer = init.signal;
  const abort = () => controller.abort();
  outer?.addEventListener("abort", abort);
  const timer = setTimeout(abort, HUB_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: controller.signal,
        // Private answers: never from or into any cache.
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch {
      return { ok: false, error: { code: "network" }, account: null };
    }
    const account = response.headers.get("x-client-hub-account");
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: { code: "network" }, account: null };
    }
    const payload = body as {
      data?: T;
      error?: { code?: unknown; fieldErrors?: Record<string, string[]> };
    } | null;
    if (response.ok && payload?.data !== undefined) {
      return { ok: true, data: payload.data, account };
    }
    const code = payload?.error?.code;
    return {
      ok: false,
      error: {
        code: typeof code === "string" ? (code as AppErrorCode) : "internal",
        ...(payload?.error?.fieldErrors
          ? { fieldErrors: payload.error.fieldErrors }
          : {}),
      },
      account,
    };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
  }
}

// State-changing requests: JSON bodies only (the routes refuse anything
// else, see assertSameOrigin), same origin by construction.
const json = (method: "POST", body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export type CodeChallenge = { challengeId: string; expiresAt: string };

/** 202: a code was emailed. Same answer whether the address is known or not. */
export function requestCode(email: string) {
  return request<CodeChallenge>(
    "/api/client-hub/session/code",
    json("POST", { email }),
  );
}

export function verifyCode(input: {
  challengeId: string;
  email: string;
  code: string;
}) {
  return request<{ email: string; expiresAt: string }>(
    "/api/client-hub/session/verify",
    json("POST", input),
  );
}

/** Ends this session (or every session of the account). */
export function endSession(all: boolean) {
  return request<{ ended: true }>(
    `/api/client-hub/session${all ? "?all=true" : ""}`,
    { method: "DELETE" },
  );
}

const business = (businessId: string) =>
  `/api/client-hub/businesses/${encodeURIComponent(businessId)}`;

export function fetchProfile(signal?: AbortSignal) {
  return request<ClientHubProfileDto>("/api/client-hub/me", {
    method: "GET",
    signal,
  });
}

export type AppointmentScope = "upcoming" | "past";

export function fetchAppointments(
  businessId: string,
  query: { scope: AppointmentScope; cursor?: string | null; limit?: number },
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ scope: query.scope });
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  return request<ClientHubAppointmentsPageDto>(
    `${business(businessId)}/appointments?${params}`,
    { method: "GET", signal },
  );
}

export function fetchAppointment(
  businessId: string,
  appointmentId: string,
  signal?: AbortSignal,
) {
  return request<ClientHubAppointmentDetailDto>(
    `${business(businessId)}/appointments/${encodeURIComponent(appointmentId)}`,
    { method: "GET", signal },
  );
}

export function fetchLoyalty(businessId: string, signal?: AbortSignal) {
  return request<ClientHubLoyaltyDto>(`${business(businessId)}/loyalty`, {
    method: "GET",
    signal,
  });
}

export function fetchLedger(
  businessId: string,
  query: { cursor?: string | null; limit?: number },
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  const search = params.size ? `?${params}` : "";
  return request<ClientHubLedgerPageDto>(
    `${business(businessId)}/loyalty/ledger${search}`,
    { method: "GET", signal },
  );
}

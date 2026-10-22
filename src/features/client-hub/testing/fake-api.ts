import { vi } from "vitest";

import type {
  ClientHubAppointmentDto,
  ClientHubBusinessDto,
  ClientHubLoyaltyDto,
  ClientHubProfileDto,
} from "@/features/client-hub/types";

// A fake of the Client Hub routes for component tests: answers are chosen
// per request (method + path), can be held to arrive late, and every call
// is recorded. A fake of the interface's transport, not of the backend's
// security: what the backend refuses is covered by the database tests.

export type Call = {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
  headers: Headers;
  init: RequestInit;
};

type Answer = { status: number; body: unknown } | "network";
type Handler = (call: Call) => Answer | Promise<Answer>;

export const ok = (data: unknown, status = 200): Answer => ({
  status,
  body: { data },
});
export const fail = (code: string, status: number): Answer => ({
  status,
  body: { error: { code, message: "backend text, never shown" } },
});

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function fakeApi() {
  const routes: { method: string; match: RegExp; handler: Handler }[] = [];
  const calls: Call[] = [];

  const fetch = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://localhost");
      const call: Call = {
        method: (init.method ?? "GET").toUpperCase(),
        path: url.pathname,
        search: url.searchParams,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        headers: new Headers(init.headers),
        init,
      };
      calls.push(call);
      // Last registered wins: a test overrides a default answer.
      const route = [...routes]
        .reverse()
        .find(
          (item) => item.method === call.method && item.match.test(call.path),
        );
      const answer = route
        ? await route.handler(call)
        : fail("client_hub_not_found", 404);
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (answer === "network") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    },
  );

  const api = {
    fetch,
    calls,
    on(method: string, match: RegExp, handler: Handler | Answer) {
      routes.push({
        method,
        match,
        handler: typeof handler === "function" ? handler : () => handler,
      });
      return api;
    },
    /** Calls to paths matching `match`. */
    to(match: RegExp, method = "GET") {
      return calls.filter(
        (call) => call.method === method && match.test(call.path),
      );
    },
    install() {
      globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
      return api;
    },
  };
  return api;
}

// ---------------------------------------------------------------------------

export const B1 = "11111111-1111-4111-8111-111111111111";
export const B2 = "22222222-2222-4222-8222-222222222222";

export const business = (
  id: string,
  name: string,
  firstName = "Camille",
): ClientHubBusinessDto => ({
  businessId: id,
  name,
  slug: name.toLowerCase().replace(/[^a-z]+/g, "-"),
  timezone: "Europe/Paris",
  location: `${name}, Paris`,
  customer: { firstName, lastName: "Martin" },
});

export const profile = (
  email: string,
  businesses: ClientHubBusinessDto[],
): ClientHubProfileDto => ({ email, businesses });

export const appointment = (
  id: string,
  startsAt: string,
  serviceName: string,
  status: ClientHubAppointmentDto["status"] = "confirmed",
): ClientHubAppointmentDto => ({
  id,
  status,
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 90 * 60_000).toISOString(),
  serviceName,
  durationMinutes: 90,
  priceCents: 8500,
  currency: "EUR",
});

export const loyalty = (
  balance: number,
  extra: Partial<ClientHubLoyaltyDto> = {},
): ClientHubLoyaltyDto => ({
  programActive: true,
  balance,
  rewards: [],
  issuedRewards: [],
  ...extra,
});

/** A future instant, `days` from now. */
export const inDays = (days: number, hour = 10) => {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() + days);
  at.setUTCHours(hour, 0, 0, 0);
  return at.toISOString();
};

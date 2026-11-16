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
//
// Like the real routes, every answer except a 401 names the account it is
// served for (X-Client-Hub-Account): by default `identity()` AT THE TIME OF
// THE REQUEST (a held answer keeps the identity it left with), or the
// answer's own `account` (null: no header).

export type Call = {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
  headers: Headers;
  init: RequestInit;
};

type Reply = { status: number; body: unknown; account?: string | null };
type Answer = Reply | "network";
type Handler = (call: Call) => Answer | Promise<Answer>;

export const ok = (data: unknown, status = 200): Reply => ({
  status,
  body: { data },
});
export const fail = (code: string, status: number): Reply => ({
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
  let identity: () => string | null = () => ACCOUNT;

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
      const servedFor = identity();
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
      const headers = new Headers({ "content-type": "application/json" });
      const account = answer.account !== undefined ? answer.account : servedFor;
      if (answer.status !== 401 && account) {
        headers.set("x-client-hub-account", account);
      }
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers,
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
    /** Who the answers are served for, read when each request leaves. */
    servedFor(current: () => string | null) {
      identity = current;
      return api;
    },
    install() {
      globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
      return api;
    },
  };
  return api;
}

// ---------------------------------------------------------------------------

/** The account answers are served for unless a test says otherwise. */
export const ACCOUNT = "acc00000-0000-4000-8000-000000000001";

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

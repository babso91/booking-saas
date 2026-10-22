import { afterEach, describe, expect, it, vi } from "vitest";

import { fail, fakeApi, ok } from "../testing/fake-api";
import {
  endSession,
  fetchAppointments,
  fetchLedger,
  fetchProfile,
  requestCode,
  verifyCode,
} from "./api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe("Client Hub transport", () => {
  it("every request is same-origin, uncached, and sends no token of its own", async () => {
    const api = fakeApi()
      .on("GET", /\/me$/, ok({ email: "a@b.fr", businesses: [] }))
      .install();
    await fetchProfile();
    const [call] = api.calls;
    expect(call!.path).toBe("/api/client-hub/me");
    expect(call!.init.credentials).toBe("same-origin");
    expect(call!.init.cache).toBe("no-store");
    expect(call!.headers.get("authorization")).toBeNull();
    expect(call!.search.toString()).toBe("");
  });

  it("state-changing requests are JSON (the routes refuse anything else)", async () => {
    const api = fakeApi()
      .on("POST", /code$/, ok({ challengeId: "x", expiresAt: "y" }, 202))
      .on("POST", /verify$/, ok({ email: "a@b.fr", expiresAt: "y" }))
      .install();
    await requestCode("a@b.fr");
    await verifyCode({ challengeId: "x", email: "a@b.fr", code: "12345678" });
    for (const call of api.calls) {
      expect(call.method).toBe("POST");
      expect(call.headers.get("content-type")).toBe("application/json");
    }
  });

  it("ends one session, or all of them", async () => {
    const api = fakeApi()
      .on("DELETE", /session$/, ok({ ended: true }))
      .install();
    await endSession(false);
    await endSession(true);
    expect(api.calls.map((call) => `${call.path}?${call.search}`)).toEqual([
      "/api/client-hub/session?",
      "/api/client-hub/session?all=true",
    ]);
  });

  it("ids and cursors are encoded, never interpreted", async () => {
    const api = fakeApi()
      .on("GET", /./, ok({ items: [], nextCursor: null }))
      .install();
    await fetchAppointments("../me", {
      scope: "past",
      cursor: "a/b+c",
      limit: 5,
    });
    await fetchLedger("b1", { cursor: null });
    expect(api.calls[0]!.path).toBe(
      "/api/client-hub/businesses/..%2Fme/appointments",
    );
    expect(api.calls[0]!.search.get("cursor")).toBe("a/b+c");
    expect(api.calls[0]!.search.get("limit")).toBe("5");
    expect(api.calls[1]!.path).toBe(
      "/api/client-hub/businesses/b1/loyalty/ledger",
    );
    expect(api.calls[1]!.search.toString()).toBe("");
  });

  it("errors keep their code (never the backend's text); no answer is `network`", async () => {
    fakeApi()
      .on("GET", /\/me$/, fail("client_hub_unauthenticated", 401))
      .install();
    expect(await fetchProfile()).toEqual({
      ok: false,
      error: { code: "client_hub_unauthenticated" },
    });
    fakeApi().on("GET", /\/me$/, "network").install();
    expect(await fetchProfile()).toEqual({
      ok: false,
      error: { code: "network" },
    });
  });

  it("an answer that is not our JSON (a proxy page) is `network`", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("<html>502</html>", { status: 502 }),
    ) as unknown as typeof fetch;
    expect(await fetchProfile()).toEqual({
      ok: false,
      error: { code: "network" },
    });
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      (_: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    const result = fetchProfile();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual({ ok: false, error: { code: "network" } });
  });
});

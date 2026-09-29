// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { callAction, PROBE_TIMEOUT_MS } from "./call-action";

// The Server Action request itself fails in transport; the probe decides why.
const lost = async () => {
  throw new TypeError("An unexpected response was received from the server.");
};

type ProbeAnswer = { status: number; redirected: boolean; url: string };

function visiting(path: string) {
  window.history.replaceState(null, "", path);
}

function probeAnswers(answer: ProbeAnswer) {
  const fetchMock = vi.fn().mockResolvedValue(answer);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const at = (path: string) => `http://localhost:3000${path}`;

describe("callAction transport failure classification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    visiting("/");
  });

  it("1 & 9. private page redirected to /login (no session) → unauthenticated", async () => {
    visiting("/app");
    const fetchMock = probeAnswers({
      status: 200,
      redirected: true,
      url: at("/login"),
    });

    expect(await callAction(lost)).toEqual({
      ok: false,
      error: { code: "unauthenticated" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/app",
      expect.objectContaining({
        method: "HEAD",
        redirect: "follow",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("2. network failure → network", async () => {
    visiting("/app");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    expect(await callAction(lost)).toEqual({
      ok: false,
      error: { code: "network" },
    });
  });

  it("3. server error → internal, never a fake session expiry", async () => {
    visiting("/app");
    probeAnswers({ status: 500, redirected: false, url: at("/app") });
    expect(await callAction(lost)).toEqual({
      ok: false,
      error: { code: "internal" },
    });
  });

  it("4. onboarding completed but response lost: /onboarding → /app is not an expired session", async () => {
    visiting("/onboarding");
    probeAnswers({ status: 200, redirected: true, url: at("/app") });
    expect(await callAction(lost)).toEqual({
      ok: false,
      error: { code: "network" },
    });
  });

  it("5. sign-in succeeded but response lost: /login → /onboarding is a new destination", async () => {
    visiting("/login");
    probeAnswers({ status: 200, redirected: true, url: at("/onboarding") });
    expect(await callAction(lost)).toEqual({
      ok: false,
      error: { code: "network" },
    });
  });

  it("6. onboarding_required user still on /onboarding → network", async () => {
    visiting("/onboarding");
    probeAnswers({ status: 200, redirected: false, url: at("/onboarding") });
    expect(await callAction(lost)).toEqual({
      ok: false,
      error: { code: "network" },
    });
  });

  it("7. ready user still on /app → network", async () => {
    visiting("/app");
    probeAnswers({ status: 200, redirected: false, url: at("/app") });
    expect(await callAction(lost)).toEqual({
      ok: false,
      error: { code: "network" },
    });
  });

  it("8. a probe that never answers is aborted after the timeout → network", async () => {
    vi.useFakeTimers();
    visiting("/app");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) =>
            init.signal!.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            ),
          ),
      ),
    );

    const pending = callAction(lost);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, error: { code: "network" } });
  });

  it("does not probe when the action answers (even with an error)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await callAction(async () => ({
        ok: false as const,
        error: { code: "unauthenticated" as const, message: "x" },
      })),
    ).toEqual({ ok: false, error: { code: "unauthenticated" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

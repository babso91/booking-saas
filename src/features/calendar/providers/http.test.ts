import { describe, expect, it, vi } from "vitest";

import { sendWithRetry, type RetryPolicy } from "./http";
import { CalendarProviderError } from "./types";

const policy = (
  sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined),
): RetryPolicy => ({
  retries: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  timeoutMs: 1000,
  sleep,
});

const response = (status: number, headers: Record<string, string> = {}) =>
  new Response("{}", { status, headers });

describe("sendWithRetry", () => {
  it("retries 429, 5xx and network errors, then succeeds", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(503))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(response(200));
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);

    const result = await sendWithRetry(
      fetch,
      "https://x.test",
      {},
      policy(sleep),
    );
    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    // Exponential backoff (with ±25 % jitter), capped.
    const delays = sleep.mock.calls.map(([ms]) => ms);
    expect(delays[0]).toBeGreaterThanOrEqual(75);
    expect(delays[2]).toBeLessThanOrEqual(500);
  });

  it("is bounded: gives up after the retries with a classified error", async () => {
    const limited = vi.fn().mockResolvedValue(response(429));
    await expect(
      sendWithRetry(limited, "https://x.test", {}, policy()),
    ).rejects.toMatchObject({
      kind: "rate_limited",
      status: 429,
    });
    expect(limited).toHaveBeenCalledTimes(4);

    const down = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      sendWithRetry(down, "https://x.test", {}, policy()),
    ).rejects.toBeInstanceOf(CalendarProviderError);
    expect(down).toHaveBeenCalledTimes(4);
  });

  it("never retries a client error", async () => {
    for (const status of [400, 401, 403, 404, 410]) {
      const fetch = vi.fn().mockResolvedValue(response(status));
      expect(
        (await sendWithRetry(fetch, "https://x.test", {}, policy())).status,
      ).toBe(status);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("honours Retry-After within the cap", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(429, { "retry-after": "60" }))
      .mockResolvedValueOnce(response(200));
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    await sendWithRetry(fetch, "https://x.test", {}, policy(sleep));
    expect(sleep.mock.calls[0]![0]).toBeLessThanOrEqual(1250);
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(750);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  sendWithRetry,
  withDeadline,
  withinDeadline,
  type RetryPolicy,
} from "./http";
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

describe("sendWithRetry deadline", () => {
  it("never sleeps past the deadline: gives up instead of retrying late", async () => {
    const fetch = vi.fn().mockResolvedValue(response(503));
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    await expect(
      sendWithRetry(
        fetch,
        "https://x.test",
        {},
        { ...policy(sleep), baseDelayMs: 5000, maxDelayMs: 5000 },
        { deadline: Date.now() + 1000 },
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("cuts each attempt's timeout to the remaining time", async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init!.signal!.addEventListener("abort", () =>
            reject(init!.signal!.reason),
          ),
        ),
    );
    const started = Date.now();
    await expect(
      sendWithRetry(
        fetch,
        "https://x.test",
        {},
        { ...policy(), timeoutMs: 10_000 },
        { deadline: Date.now() + 200 },
      ),
    ).rejects.toBeInstanceOf(CalendarProviderError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("refuses to start once the deadline passed", async () => {
    const fetch = vi.fn();
    await expect(
      sendWithRetry(fetch, "https://x.test", {}, policy(), {
        deadline: Date.now() - 1,
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("withDeadline", () => {
  it("never starts an operation whose deadline passed", async () => {
    const run = vi.fn(async () => "x");
    await expect(withDeadline(Date.now() - 1, run)).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("aborts a late operation and consumes its late rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    let seen: AbortSignal | undefined;
    await expect(
      withDeadline(Date.now() + 50, (signal) => {
        seen = signal;
        return new Promise((_, reject) =>
          setTimeout(() => reject(new Error("late")), 200),
        );
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(seen?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.off("unhandledRejection", listener);
    expect(unhandled).toEqual([]);
  });

  it("returns the result of an operation that ends in time", async () => {
    await expect(
      withDeadline(Date.now() + 1000, async () => "done"),
    ).resolves.toBe("done");
  });
});

describe("withinDeadline: which came first, said explicitly", () => {
  const sentinel = new Error("sentinel");

  async function settle<T>(promise: Promise<T>) {
    return promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  }

  it("A. its timer firing a millisecond before the clock reaches the deadline: the deadline, signal aborted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let signal!: AbortSignal;
      const outcome = settle(
        withinDeadline(Date.now() + 1000, (s) => {
          signal = s;
          return new Promise<never>(() => undefined);
        }),
      );
      vi.setSystemTime(Date.now() - 1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await outcome).toEqual({ value: { expired: true } });
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("B. a real failure a millisecond before the deadline, looked at after the clock passed it: that failure, unchanged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const start = Date.now();
      let fail!: (error: Error) => void;
      let signal!: AbortSignal;
      const outcome = withinDeadline(start + 1000, (s) => {
        signal = s;
        return new Promise<never>((_, reject) => (fail = reject));
      });
      await vi.advanceTimersByTimeAsync(999);
      vi.setSystemTime(start + 1001);
      fail(sentinel);
      expect(await settle(outcome)).toEqual({ error: sentinel });
      expect(signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("C. the deadline first, a real failure later: the deadline; the late failure is consumed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let fail!: (error: Error) => void;
      const outcome = settle(
        withinDeadline(Date.now() + 1000, () => {
          return new Promise<never>((_, reject) => (fail = reject));
        }),
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(await outcome).toEqual({ value: { expired: true } });
      fail(sentinel);
      vi.useRealTimers();
      for (let turn = 0; turn < 5; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });

  it("a value before the deadline; an expired deadline never starts the run", async () => {
    expect(await withinDeadline(Date.now() + 1000, async () => 42)).toEqual({
      expired: false,
      value: 42,
    });
    const run = vi.fn(async () => 1);
    expect(await withinDeadline(Date.now() - 1, run)).toEqual({
      expired: true,
    });
    expect(run).not.toHaveBeenCalled();
  });
});

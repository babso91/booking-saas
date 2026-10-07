import { describe, expect, it, vi } from "vitest";

import {
  DeadlineExceededError,
  isDeadlineCut,
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
      expect(await outcome).toEqual({
        value: { expired: true, cause: "deadline" },
      });
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
      expect(await outcome).toEqual({
        value: { expired: true, cause: "deadline" },
      });
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
      cause: "deadline",
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("withinDeadline: parent signal, late settlements, timers", () => {
  const sentinel = new Error("sentinel");
  const pending = () => new Promise<never>(() => undefined);

  async function withFakeTimers(test: () => Promise<void>) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await test();
      vi.useRealTimers();
      for (let turn = 0; turn < 5; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  }

  it("the parent aborted first: cause parent, the run's signal aborted, the later local deadline changes nothing", () =>
    withFakeTimers(async () => {
      const parent = new AbortController();
      let signal!: AbortSignal;
      const outcome = withinDeadline(
        Date.now() + 1000,
        (s) => {
          signal = s;
          return pending();
        },
        parent.signal,
      );
      await vi.advanceTimersByTimeAsync(400);
      parent.abort();
      expect(await outcome).toEqual({ expired: true, cause: "parent" });
      expect(signal.aborted).toBe(true);
      // Its timer is gone: nothing fires at the local deadline.
      expect(vi.getTimerCount()).toBe(0);
    }));

  it("a parent already aborted: the run is never started", async () => {
    const parent = new AbortController();
    parent.abort();
    const run = vi.fn(async () => 1);
    expect(await withinDeadline(Date.now() + 1000, run, parent.signal)).toEqual(
      { expired: true, cause: "parent" },
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("a real failure first, the parent aborted afterwards: the failure, unchanged", () =>
    withFakeTimers(async () => {
      const parent = new AbortController();
      let fail!: (error: Error) => void;
      const outcome = withinDeadline(
        Date.now() + 1000,
        () => new Promise<never>((_, reject) => (fail = reject)),
        parent.signal,
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(500);
      fail(sentinel);
      // A millisecond later (the failure has settled the race by then).
      await vi.advanceTimersByTimeAsync(1);
      parent.abort();
      expect(await outcome).toEqual({ error: sentinel });
    }));

  it("the parent aborted first, a real failure later: parent, the late failure consumed", () =>
    withFakeTimers(async () => {
      const parent = new AbortController();
      let fail!: (error: Error) => void;
      const outcome = withinDeadline(
        Date.now() + 1000,
        () => new Promise<never>((_, reject) => (fail = reject)),
        parent.signal,
      );
      parent.abort();
      expect(await outcome).toEqual({ expired: true, cause: "parent" });
      fail(sentinel);
    }));

  it("the local deadline with the parent still active: cause deadline; the parent's listener is removed", () =>
    withFakeTimers(async () => {
      const parent = new AbortController();
      const add = vi.spyOn(parent.signal, "addEventListener");
      const remove = vi.spyOn(parent.signal, "removeEventListener");
      const outcome = withinDeadline(
        Date.now() + 1000,
        () => pending(),
        parent.signal,
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(await outcome).toEqual({ expired: true, cause: "deadline" });
      expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
      parent.abort();
    }));

  it("the deadline first, a late answer: the deadline, the answer consumed", () =>
    withFakeTimers(async () => {
      let answer!: (value: number) => void;
      const outcome = withinDeadline(
        Date.now() + 1000,
        () => new Promise<number>((resolve) => (answer = resolve)),
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(await outcome).toEqual({ expired: true, cause: "deadline" });
      answer(7);
    }));

  it("settled early (answer or failure): its timer is cleared, nothing aborts it later", () =>
    withFakeTimers(async () => {
      const parent = new AbortController();
      let signal!: AbortSignal;
      expect(
        await withinDeadline(
          Date.now() + 1000,
          async (s) => {
            signal = s;
            return 1;
          },
          parent.signal,
        ),
      ).toEqual({ expired: false, value: 1 });
      expect(vi.getTimerCount()).toBe(0);
      await expect(
        withinDeadline(Date.now() + 1000, async () => {
          throw sentinel;
        }),
      ).rejects.toBe(sentinel);
      expect(vi.getTimerCount()).toBe(0);
      parent.abort();
      expect(signal.aborted).toBe(false);
    }));
});

describe("sendWithRetry: the deadline is told by its own abort, never by the clock", () => {
  const hanging = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) =>
      init!.signal!.addEventListener("abort", () =>
        reject(init!.signal!.reason),
      ),
    );

  it("a fractional deadline still sends the request (whole-millisecond timeout)", async () => {
    const fetch = vi.fn(async () => response(200));
    const answered = await sendWithRetry(
      fetch,
      "https://x.test",
      {},
      { ...policy(), timeoutMs: 10_000 },
      { deadline: Date.now() + 800.5 },
    );
    expect(answered.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("an attempt cut by the deadline-capped timeout: DeadlineExceededError", async () => {
    await expect(
      sendWithRetry(
        vi.fn(hanging),
        "https://x.test",
        {},
        { ...policy(), timeoutMs: 10_000 },
        { deadline: Date.now() + 100 },
      ),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it("an attempt cut by its own timeout (the deadline far): retried, then a real unavailability", async () => {
    const fetch = vi.fn(hanging);
    const error = await sendWithRetry(
      fetch,
      "https://x.test",
      {},
      { ...policy(), retries: 1, timeoutMs: 30 },
      { deadline: Date.now() + 60_000 },
    ).catch((caught: unknown) => caught);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(CalendarProviderError);
    expect(error).not.toBeInstanceOf(DeadlineExceededError);
  });

  it("an abort that is not ours, even with the deadline close: never the deadline", async () => {
    const fetch = vi.fn(async () => {
      throw new DOMException("aborted elsewhere", "AbortError");
    });
    const error = await sendWithRetry(
      fetch,
      "https://x.test",
      {},
      { ...policy(), retries: 0, timeoutMs: 10_000 },
      { deadline: Date.now() + 5_000 },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CalendarProviderError);
    expect(error).not.toBeInstanceOf(DeadlineExceededError);
  });

  it("a real failure answer near the deadline is returned as is (the caller sees the real status)", async () => {
    const fetch = vi.fn(async () => response(400));
    const answered = await sendWithRetry(
      fetch,
      "https://x.test",
      {},
      { ...policy(), timeoutMs: 10_000 },
      { deadline: Date.now() + 5 },
    );
    expect(answered.status).toBe(400);
  });

  it("a body cut by the deadline-capped timeout is recognised as the deadline's", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init!.signal!;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // As fetch does: the body errors with the signal's abort reason.
          signal.addEventListener("abort", () =>
            controller.error(signal.reason),
          );
        },
      });
      return new Response(body, { status: 200 });
    });
    const answered = await sendWithRetry(
      fetch,
      "https://x.test",
      {},
      { ...policy(), timeoutMs: 10_000 },
      { deadline: Date.now() + 100 },
    );
    const error = await answered.json().catch((caught: unknown) => caught);
    expect(isDeadlineCut(answered, error)).toBe(true);
    expect(isDeadlineCut(answered, new Error("other"))).toBe(false);
  });
});

describe("sendWithRetry: a fractional budget is rounded down, never up", () => {
  /** The clock frozen: the budget left is exactly `deadline - now`. */
  async function attempt(
    budgetMs: number,
    fetch = vi.fn(async () => response(200)),
  ) {
    vi.useFakeTimers({ toFake: ["Date"] });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const outcome = await sendWithRetry(
        fetch,
        "https://x.test",
        {},
        { ...policy(), timeoutMs: 10_000 },
        { deadline: Date.now() + budgetMs },
      ).then(
        (answered) => ({ status: answered.status }),
        (error: unknown) => ({ error }),
      );
      return {
        outcome,
        fetch,
        timeouts: timeout.mock.calls.map(([ms]) => ms),
      };
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  }

  it.each([0.1, 0.9, 0, -5])(
    "%s ms left: no request starts, the deadline is exhausted",
    async (budget) => {
      const { outcome, fetch, timeouts } = await attempt(budget);
      expect(fetch).not.toHaveBeenCalled();
      expect(timeouts).toEqual([]);
      expect(outcome).toEqual({ error: expect.any(DeadlineExceededError) });
    },
  );

  it.each([
    [1.0, 1],
    [1.1, 1],
    [800.5, 800],
  ])(
    "%s ms left: the request starts with a %s ms timeout",
    async (budget, ms) => {
      const { outcome, fetch, timeouts } = await attempt(budget);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(timeouts).toEqual([ms]);
      expect(outcome).toEqual({ status: 200 });
    },
  );

  it("a retryable failure with less than a whole millisecond left: no second request, the deadline is exhausted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      const fetch = vi.fn(async () => {
        // The attempt took all but 0.7 ms of the budget.
        vi.setSystemTime(start + 1_000);
        return response(503);
      });
      const error = await sendWithRetry(
        fetch,
        "https://x.test",
        {},
        { ...policy(), baseDelayMs: 0, maxDelayMs: 0, timeoutMs: 10_000 },
        { deadline: start + 1_000.7 },
      ).catch((caught: unknown) => caught);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(DeadlineExceededError);
    } finally {
      vi.useRealTimers();
    }
  });
});

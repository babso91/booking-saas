import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarDeps } from "./deps";
import { logCalendar } from "./log";
import { outboundPhases, processOutbound } from "./outbound";
import { backfillOutbound, reconcileOutbound } from "./reconcile";

vi.mock("./reconcile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reconcile")>()),
  backfillOutbound: vi.fn(),
  reconcileOutbound: vi.fn(),
}));
vi.mock("./log", () => ({ logCalendar: vi.fn() }));

// Inside outbound, writes have priority up to OUTBOUND_WRITE_SHARE of the
// budget and reconciliation is guaranteed the rest. The priority phase has
// a real deadline covering its database calls: a claim that does not
// answer (a lock wait, a slow database) is abandoned at the phase's
// deadline, its signal aborted, its late answer or failure consumed.

type Answer = { data: unknown; error: { message: string } | null };

type DatabaseCall = PromiseLike<Answer> & {
  signal?: AbortSignal;
  abortSignal(signal: AbortSignal): DatabaseCall;
  answer(late: Answer): void;
  fail(error: Error): void;
};

function databaseCall(honoursAbort: boolean): DatabaseCall {
  let settle!: (late: PromiseLike<Answer>) => void;
  const answer = new Promise<Answer>((resolve) => {
    settle = resolve;
  });
  const call: DatabaseCall = {
    abortSignal(signal) {
      call.signal = signal;
      if (honoursAbort) {
        signal.addEventListener("abort", () =>
          settle(
            Promise.resolve({
              data: null,
              error: { message: "AbortError: aborted" },
            }),
          ),
        );
      }
      return call;
    },
    then: (onFulfilled, onRejected) => answer.then(onFulfilled, onRejected),
    answer: (late) => settle(Promise.resolve(late)),
    fail: (error) => settle(Promise.reject(error)),
  };
  return call;
}

const quick = (data: unknown) => {
  const call = databaseCall(false);
  call.answer({ data, error: null });
  return call;
};

/** The first claim is `slow`; any later one finds nothing due. */
function depsWith(slow: DatabaseCall) {
  let claims = 0;
  const rpc = vi.fn((name: string) => {
    if (name === "calendar_outbound_claim_mirrors") {
      claims += 1;
      return claims === 1 ? slow : quick([]);
    }
    return quick([]);
  });
  const provider = vi.fn();
  return {
    deps: { admin: { rpc }, env: {}, provider } as unknown as CalendarDeps,
    rpc,
    provider,
  };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

async function drain() {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const BUDGET = 25_000;
const PRIORITY = outboundPhases(BUDGET).priorityMs;

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.mocked(backfillOutbound).mockResolvedValue(0);
  vi.mocked(reconcileOutbound).mockResolvedValue({
    reconciled: 1,
    drifted: 0,
    actionRequired: 0,
  });
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("outbound: a slow writer database call cannot take reconciliation's share", () => {
  it("a claim that never answers is abandoned at the priority deadline: its signal aborted, reconciliation runs with the rest of the budget", async () => {
    const claim = databaseCall(true);
    const { deps } = depsWith(claim);
    const start = Date.now();

    const run = processOutbound(deps, { budgetMs: BUDGET });
    await vi.advanceTimersByTimeAsync(PRIORITY - 1);
    expect(reconcileOutbound).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await run;

    expect(claim.signal?.aborted).toBe(true);
    expect(reconcileOutbound).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(reconcileOutbound).mock.calls[0]!;
    expect(options.deadline).toBe(start + BUDGET);
    // Called within its reserved slice, at the priority deadline.
    expect(Date.now()).toBe(start + PRIORITY);
    expect(result).toMatchObject({ reconciled: 1, applied: 0 });
    await drain();
    expect(unhandled).toEqual([]);
  });

  it("the phase timer firing a millisecond before the clock reaches it is still the phase's deadline, not a write failure", async () => {
    const claim = databaseCall(false);
    const { deps } = depsWith(claim);
    const run = processOutbound(deps, { budgetMs: BUDGET });
    vi.setSystemTime(Date.now() - 1);
    await vi.advanceTimersByTimeAsync(PRIORITY);
    await run;
    expect(reconcileOutbound).toHaveBeenCalledTimes(1);
    const operations = vi.mocked(logCalendar).mock.calls.map(([op]) => op);
    expect(operations).toContain("outbound_phase_deadline_exceeded");
    expect(operations).not.toContain("outbound_writes_failed");
  });

  it("its late answer is consumed: the granted claims are never written (their leases expire)", async () => {
    const claim = databaseCall(false);
    const { deps, rpc, provider } = depsWith(claim);

    const run = processOutbound(deps, { budgetMs: BUDGET });
    await vi.advanceTimersByTimeAsync(PRIORITY);
    await run;
    expect(reconcileOutbound).toHaveBeenCalledTimes(1);
    const calls = rpc.mock.calls.length;

    claim.answer({
      data: [
        {
          appointmentId: "a1",
          businessId: "b1",
          claimId: "c1",
          revision: 2,
          repairGeneration: 0,
          repair: false,
        },
      ],
      error: null,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await drain();
    expect(rpc.mock.calls.length).toBe(calls);
    expect(provider).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it("its late failure is consumed, never an unhandled rejection", async () => {
    const claim = databaseCall(false);
    const { deps } = depsWith(claim);

    const run = processOutbound(deps, { budgetMs: BUDGET });
    await vi.advanceTimersByTimeAsync(PRIORITY);
    expect((await run).reconciled).toBe(1);

    claim.fail(new Error("connection reset"));
    await vi.advanceTimersByTimeAsync(30_000);
    await drain();
    expect(unhandled).toEqual([]);
  });

  it("a kick (one business) has no phases: it waits for its own claim within its budget", async () => {
    const claim = databaseCall(false);
    const { deps } = depsWith(claim);
    const run = processOutbound(deps, { businessId: "b1", budgetMs: BUDGET });
    claim.answer({ data: [], error: null });
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(reconcileOutbound).not.toHaveBeenCalled();
    expect(backfillOutbound).not.toHaveBeenCalled();
  });

  describe("the job's own abort (parent) against the phase's deadline", () => {
    const operations = () =>
      vi.mocked(logCalendar).mock.calls.map(([operation]) => operation);

    it("A. the parent aborted first, the claim ignoring it: no later phase timeout, no failure, nothing after", async () => {
      const claim = databaseCall(false);
      const { deps, provider } = depsWith(claim);
      const parent = new AbortController();
      const run = processOutbound(deps, {
        budgetMs: BUDGET,
        signal: parent.signal,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      parent.abort();
      await vi.advanceTimersByTimeAsync(BUDGET);
      await run;
      expect(operations()).not.toContain("outbound_phase_deadline_exceeded");
      expect(operations()).not.toContain("outbound_writes_failed");
      expect(reconcileOutbound).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      await drain();
      expect(unhandled).toEqual([]);
    });

    it("B. the phase's own deadline, the parent still active: the phase timeout, logged once", async () => {
      const claim = databaseCall(false);
      const { deps } = depsWith(claim);
      const parent = new AbortController();
      const run = processOutbound(deps, {
        budgetMs: BUDGET,
        signal: parent.signal,
      });
      await vi.advanceTimersByTimeAsync(PRIORITY);
      await run;
      expect(
        operations().filter((op) => op === "outbound_phase_deadline_exceeded"),
      ).toHaveLength(1);
      expect(reconcileOutbound).toHaveBeenCalledTimes(1);
    });

    it("C. a real failure first, the parent aborted later: the failure is logged", async () => {
      const claim = databaseCall(false);
      const { deps } = depsWith(claim);
      const parent = new AbortController();
      const run = processOutbound(deps, {
        budgetMs: BUDGET,
        signal: parent.signal,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      claim.answer({ data: null, error: { message: "sentinel" } });
      await vi.advanceTimersByTimeAsync(1);
      parent.abort();
      await vi.advanceTimersByTimeAsync(BUDGET);
      await run;
      expect(operations()).toContain("outbound_writes_failed");
      expect(operations()).not.toContain("outbound_phase_deadline_exceeded");
    });

    it("D. the parent aborted first, a real failure later: consumed, no failure log", async () => {
      const claim = databaseCall(false);
      const { deps } = depsWith(claim);
      const parent = new AbortController();
      const run = processOutbound(deps, {
        budgetMs: BUDGET,
        signal: parent.signal,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      parent.abort();
      await run;
      claim.fail(new Error("late"));
      await vi.advanceTimersByTimeAsync(BUDGET);
      await drain();
      expect(operations()).not.toContain("outbound_writes_failed");
      expect(operations()).not.toContain("outbound_phase_deadline_exceeded");
      expect(unhandled).toEqual([]);
    });
  });
});

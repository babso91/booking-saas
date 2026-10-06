import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CALENDAR_JOB_BUDGET_MS,
  INBOUND_SHARE,
  OUTBOUND_TAIL_MS,
  runCalendarJob,
} from "./cron";
import type { CalendarDeps } from "./deps";
import { logCalendar } from "./log";
import {
  outboundPhases,
  processOutbound,
  RECONCILIATION_RESERVE_MS,
} from "./outbound";
import {
  RECONCILIATION_MIN_START_MS,
  RECONCILIATION_PAGE_MIN_MS,
  reconcileOutbound,
} from "./reconcile";

vi.mock("./connection", () => ({
  refreshConnectionCalendars: vi.fn(),
  beginOAuthState: vi.fn(),
}));
vi.mock("./sync", () => ({ syncCalendar: vi.fn() }));
vi.mock("./log", () => ({ logCalendar: vi.fn() }));
vi.mock("./tokens", () => ({
  StaleCredentialsError: class StaleCredentialsError extends Error {},
  getAccessToken: vi.fn(),
  withAccessToken: (
    _deps: unknown,
    _connectionId: string,
    run: (token: string) => unknown,
  ) => run("token"),
}));

// The periodic job at its real budget, with the real outbound scheduler and
// the real reconciler (its own start gates), only the database and Google
// replaced. The reserved reconciliation slice must be one the reconciler
// accepts to start in; a slice too short for a safe start must not start a
// provider call.

type Answer = { data: unknown; error: { message: string } | null };

type DatabaseCall = PromiseLike<Answer> & {
  signal?: AbortSignal;
  abortSignal(signal: AbortSignal): DatabaseCall;
  answer(late: Answer): void;
};

/** A call that answers only when told, or with an AbortError when aborted. */
function heldCall(): DatabaseCall {
  let settle!: (late: Answer) => void;
  const answer = new Promise<Answer>((resolve) => (settle = resolve));
  const call: DatabaseCall = {
    abortSignal(signal) {
      call.signal = signal;
      const abort = () =>
        settle({ data: null, error: { message: "AbortError: aborted" } });
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort);
      return call;
    },
    then: (onFulfilled, onRejected) => answer.then(onFulfilled, onRejected),
    answer: (late) => settle(late),
  };
  return call;
}

const quick = (data: unknown): DatabaseCall => {
  const call = heldCall();
  call.answer({ data, error: null });
  return call;
};

const reconciliationClaim = {
  businessId: "b1",
  claimId: "c1",
  connectionId: "k1",
  credentialGeneration: "g1",
  calendarId: "cal1",
  mode: "incremental",
  syncToken: "s0",
  pageToken: null,
};

function setup(options: { reconciliationClaimDelayMs?: number } = {}) {
  const times: Record<string, number[]> = {};
  const writerClaims: DatabaseCall[] = [];
  let reconciliationClaims = 0;
  const rpc = vi.fn((name: string) => {
    (times[name] ??= []).push(Date.now());
    switch (name) {
      case "calendar_due_work":
        // Inbound waits on the database for its whole share.
        return heldCall();
      case "calendar_outbound_claim_mirrors": {
        // The writer's claim waits for the whole priority phase.
        const call = writerClaims.length === 0 ? heldCall() : quick([]);
        writerClaims.push(call);
        return call;
      }
      case "calendar_outbound_backfill":
        return quick({ businesses: 0, enrolled: 0 });
      case "calendar_outbound_claim_reconciliation": {
        reconciliationClaims += 1;
        const data = reconciliationClaims === 1 ? reconciliationClaim : null;
        if (!options.reconciliationClaimDelayMs) return quick(data);
        const call = heldCall();
        setTimeout(
          () => call.answer({ data, error: null }),
          options.reconciliationClaimDelayMs,
        );
        return call;
      }
      case "calendar_outbound_reconciliation_page":
        return quick({ result: "done", repairs: 0 });
      case "calendar_outbound_reconciliation_release":
        return quick(true);
      default:
        return quick([]);
    }
  });
  const listOwnedEvents = vi.fn(
    async (
      _token: string,
      _calendarId: string,
      _query: unknown,
      _pageToken: string | null,
      callOptions: { deadline?: number },
    ) => {
      (times.listOwnedEvents ??= []).push(Date.now());
      expect(callOptions.deadline).toBeDefined();
      return { events: [], nextPageToken: null, nextSyncToken: "s1" };
    },
  );
  const provider = {
    listOwnedEvents,
    calendarExists: vi.fn(),
    ownedEventDiffers: vi.fn(() => false),
  };
  const deps = {
    admin: { rpc },
    env: {},
    provider: () => provider,
  } as unknown as CalendarDeps;
  return { deps, rpc, times, listOwnedEvents, writerClaims };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

async function drain() {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("outbound budget model", () => {
  it("the slice reserved at the job's smallest outbound budget is one reconciliation starts in", () => {
    const smallest =
      CALENDAR_JOB_BUDGET_MS * (1 - INBOUND_SHARE) - OUTBOUND_TAIL_MS;
    expect(smallest).toBe(19_500);
    const phases = outboundPhases(smallest);
    expect(phases.priorityMs + phases.reconciliationMs).toBe(smallest);
    expect(phases.reconciliationMs).toBeGreaterThanOrEqual(
      RECONCILIATION_RESERVE_MS,
    );
    expect(RECONCILIATION_RESERVE_MS).toBeGreaterThan(
      RECONCILIATION_MIN_START_MS,
    );
    expect(RECONCILIATION_MIN_START_MS).toBeGreaterThan(
      RECONCILIATION_PAGE_MIN_MS,
    );
    // Writes keep priority: most of the budget.
    expect(phases.priorityMs).toBeGreaterThan(phases.reconciliationMs);
  });

  it("at the real minimum (inbound takes its whole 30 s, the writer's claim its whole priority phase), reconciliation starts and lists within the run's deadline", async () => {
    const { deps, times, listOwnedEvents, rpc } = setup();
    const start = Date.now();

    const job = runCalendarJob(deps, { budgetMs: CALENDAR_JOB_BUDGET_MS });
    await vi.advanceTimersByTimeAsync(CALENDAR_JOB_BUDGET_MS);
    const result = await job;

    const outboundStart = start + CALENDAR_JOB_BUDGET_MS * INBOUND_SHARE;
    const outboundBudget =
      CALENDAR_JOB_BUDGET_MS * (1 - INBOUND_SHARE) - OUTBOUND_TAIL_MS;
    const priorityDeadline =
      outboundStart + outboundPhases(outboundBudget).priorityMs;
    const outboundDeadline = outboundStart + outboundBudget;

    // The writer went first and held its whole priority phase.
    expect(times.calendar_outbound_claim_mirrors![0]).toBe(outboundStart);
    // Reconciliation started in its reserved slice, at the priority deadline.
    expect(times.calendar_outbound_claim_reconciliation?.[0]).toBe(
      priorityDeadline,
    );
    expect(listOwnedEvents).toHaveBeenCalledTimes(1);
    const [, , , , callOptions] = listOwnedEvents.mock.calls[0]!;
    // No provider call may outlive outbound's deadline (nor the run's).
    expect(callOptions.deadline).toBe(outboundDeadline);
    expect(outboundDeadline).toBeLessThanOrEqual(
      start + CALENDAR_JOB_BUDGET_MS,
    );
    expect(
      rpc.mock.calls.some(
        ([name]) => name === "calendar_outbound_reconciliation_page",
      ),
    ).toBe(true);
    expect(result.outbound).toMatchObject({ reconciled: 1 });
    expect(Date.now()).toBeLessThanOrEqual(start + CALENDAR_JOB_BUDGET_MS);
    await drain();
    expect(unhandled).toEqual([]);
  });

  it("a budget too small to hold a write and a reserved slice reserves none: reconciliation does not start", async () => {
    const { deps, times, listOwnedEvents } = setup();
    const budget = 5_000;
    expect(budget).toBeLessThan(1_500 + RECONCILIATION_RESERVE_MS);

    const run = processOutbound(deps, { budgetMs: budget });
    await vi.advanceTimersByTimeAsync(budget);
    await run;

    expect(times.calendar_outbound_claim_reconciliation).toBeUndefined();
    expect(listOwnedEvents).not.toHaveBeenCalled();
  });

  it("with less than a page's minimum left once a business is claimed, the pass stops before any provider call (cursor kept)", async () => {
    const { deps, times, listOwnedEvents, rpc } = setup({
      reconciliationClaimDelayMs: 600,
    });
    const run = reconcileOutbound(deps, {
      deadline: Date.now() + RECONCILIATION_MIN_START_MS,
    });
    await vi.advanceTimersByTimeAsync(RECONCILIATION_MIN_START_MS);
    expect(await run).toMatchObject({ reconciled: 0 });

    expect(times.calendar_outbound_claim_reconciliation).toHaveLength(1);
    expect(listOwnedEvents).not.toHaveBeenCalled();
    expect(
      rpc.mock.calls.some(
        ([name]) => name === "calendar_outbound_reconciliation_release",
      ),
    ).toBe(true);
  });

  it("with less than its start minimum, reconciliation claims nothing", async () => {
    const { deps, times } = setup();
    await reconcileOutbound(deps, {
      deadline: Date.now() + RECONCILIATION_MIN_START_MS - 1,
    });
    expect(times.calendar_outbound_claim_reconciliation).toBeUndefined();
  });
});

describe("deadline or real failure: said by the deadline mechanism, never by the clock", () => {
  it("a real failure of the writer's claim a millisecond before the priority deadline, handled after the clock passed it, is a failure", async () => {
    const { deps, writerClaims } = setup();
    const budget = 25_000;
    const priority = outboundPhases(budget).priorityMs;
    const start = Date.now();

    const run = processOutbound(deps, { budgetMs: budget });
    await vi.advanceTimersByTimeAsync(priority - 1);
    // The database fails now; its rejection is handled once the clock has
    // passed the deadline, before the deadline timer has fired.
    vi.setSystemTime(start + priority + 1);
    writerClaims[0]!.answer({ data: null, error: { message: "sentinel" } });
    await vi.advanceTimersByTimeAsync(budget);
    await run;

    const operations = vi.mocked(logCalendar).mock.calls.map(([op]) => op);
    expect(operations).toContain("outbound_writes_failed");
    expect(operations).not.toContain("outbound_phase_deadline_exceeded");
  });

  it("a real inbound failure just before inbound's deadline is reported by the job, not taken for its deadline", async () => {
    const { deps, rpc } = setup();
    const start = Date.now();
    const inboundDeadline = start + CALENDAR_JOB_BUDGET_MS * INBOUND_SHARE;
    let dueWork!: DatabaseCall;
    rpc.mockImplementation(((name: string) => {
      if (name === "calendar_due_work") return (dueWork = heldCall());
      return quick([]);
    }) as never);

    const job = runCalendarJob(deps, { budgetMs: CALENDAR_JOB_BUDGET_MS });
    const settled = job.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(inboundDeadline - start - 1);
    vi.setSystemTime(inboundDeadline + 1);
    dueWork.answer({ data: null, error: { message: "sentinel" } });
    await vi.advanceTimersByTimeAsync(CALENDAR_JOB_BUDGET_MS);

    expect(await settled).toEqual({ message: "sentinel" });
    const operations = vi.mocked(logCalendar).mock.calls.map(([op]) => op);
    expect(operations).not.toContain("inbound_deadline_exceeded");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INBOUND_SHARE, runCalendarJob } from "./cron";
import type { CalendarDeps } from "./deps";
import { processOutbound, type OutboundRunResult } from "./outbound";
import { syncCalendar } from "./sync";

vi.mock("./connection", () => ({ refreshConnectionCalendars: vi.fn() }));
vi.mock("./sync", () => ({ syncCalendar: vi.fn() }));
vi.mock("./outbound", () => ({ processOutbound: vi.fn() }));
vi.mock("./log", () => ({ logCalendar: vi.fn() }));

// The periodic job's two directions each have a real deadline: whatever one
// waits for (here a database call that does not answer) is abandoned at its
// deadline, its signal aborted and its late result consumed.

type Answer = { data: unknown; error: { message: string } | null };

/** A database call as supabase-js builds it: a thenable taking a signal. */
type DatabaseCall = PromiseLike<Answer> & {
  signal?: AbortSignal;
  abortSignal(signal: AbortSignal): DatabaseCall;
  answer(late: Answer): void;
  fail(error: Error): void;
};

/**
 * `honoursAbort`: an abort settles the call at once with an AbortError
 * result, as postgrest-js does; otherwise only `answer`/`fail` settle it.
 */
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

function depsWith(dueWork: DatabaseCall) {
  const rpc = vi.fn((name: string) =>
    name === "calendar_due_work" ? dueWork : quick([]),
  );
  return { deps: { admin: { rpc }, env: {} } as unknown as CalendarDeps, rpc };
}

const outboundResult = {
  creations: 0,
  applied: 1,
  retried: 0,
  superseded: 0,
  actionRequired: 0,
};

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

/** Lets Node report any unhandled rejection (real macrotask turns). */
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

describe("periodic job: real deadlines per direction", () => {
  it("an inbound database call that never answers is abandoned at inbound's deadline: its signal aborted, outbound gets the rest of the budget", async () => {
    const dueWork = databaseCall(true);
    const { deps } = depsWith(dueWork);
    vi.mocked(processOutbound).mockResolvedValue(outboundResult);

    const job = runCalendarJob(deps, { budgetMs: 50_000 });
    await vi.advanceTimersByTimeAsync(50_000 * INBOUND_SHARE);
    const result = await job;

    expect(dueWork.signal?.aborted).toBe(true);
    expect(processOutbound).toHaveBeenCalledTimes(1);
    const options = vi.mocked(processOutbound).mock.calls[0]![1]!;
    expect(options.budgetMs).toBeGreaterThanOrEqual(
      50_000 * (1 - INBOUND_SHARE) - 500,
    );
    expect(options.signal?.aborted).toBe(false);
    expect(result).toEqual({ due: 0, processed: [], outbound: outboundResult });
    expect(syncCalendar).not.toHaveBeenCalled();
    await drain();
    expect(unhandled).toEqual([]);
  });

  it("a late answer of the abandoned call is consumed: nothing starts after inbound's deadline", async () => {
    const dueWork = databaseCall(false);
    const { deps } = depsWith(dueWork);
    vi.mocked(processOutbound).mockResolvedValue(outboundResult);

    const job = runCalendarJob(deps, { budgetMs: 50_000 });
    await vi.advanceTimersByTimeAsync(50_000 * INBOUND_SHARE);
    await job;
    expect(dueWork.signal?.aborted).toBe(true);

    dueWork.answer({
      data: [{ calendar_id: "c1", reason: "due" }],
      error: null,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await drain();
    expect(syncCalendar).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it("a late failure of the abandoned call is consumed, never an unhandled rejection", async () => {
    const dueWork = databaseCall(false);
    const { deps } = depsWith(dueWork);
    vi.mocked(processOutbound).mockResolvedValue(outboundResult);

    const job = runCalendarJob(deps, { budgetMs: 50_000 });
    await vi.advanceTimersByTimeAsync(50_000 * INBOUND_SHARE);
    expect((await job).outbound).toEqual(outboundResult);

    dueWork.fail(new Error("connection reset"));
    await vi.advanceTimersByTimeAsync(10_000);
    await drain();
    expect(unhandled).toEqual([]);
  });

  it("a slow outbound pass is abandoned at the run's deadline, after inbound had its share: its signal aborted, its late failure consumed", async () => {
    const dueWork = databaseCall(false);
    dueWork.answer({
      data: [{ calendar_id: "c1", reason: "due" }],
      error: null,
    });
    const { deps } = depsWith(dueWork);
    vi.mocked(syncCalendar).mockResolvedValue("synced");
    let failLate!: (error: Error) => void;
    vi.mocked(processOutbound).mockImplementation(
      () => new Promise<OutboundRunResult>((_, reject) => (failLate = reject)),
    );

    const job = runCalendarJob(deps, { budgetMs: 50_000 });
    await vi.advanceTimersByTimeAsync(50_000);
    const result = await job;

    expect(result.processed).toEqual([
      { calendarId: "c1", reason: "due", outcome: "synced" },
    ]);
    expect(vi.mocked(syncCalendar).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(processOutbound).mock.invocationCallOrder[0]!,
    );
    expect(result.outbound).toBeNull();
    expect(vi.mocked(processOutbound).mock.calls[0]![1]!.signal?.aborted).toBe(
      true,
    );

    failLate(new Error("late"));
    await drain();
    expect(unhandled).toEqual([]);
  });

  it("an inbound failure never takes outbound's turn: outbound runs, then the failure is reported", async () => {
    const dueWork = databaseCall(false);
    dueWork.answer({ data: null, error: { message: "boom" } });
    const { deps } = depsWith(dueWork);
    vi.mocked(processOutbound).mockResolvedValue(outboundResult);

    const job = runCalendarJob(deps, { budgetMs: 50_000 });
    const settled = job.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await settled).toEqual({ message: "boom" });
    expect(processOutbound).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeadlineExceededError } from "@/features/calendar/providers/http";
import { CalendarProviderError } from "@/features/calendar/providers/types";

import type { CalendarDeps } from "./deps";
import { failureOf, syncCalendar } from "./sync";

vi.mock("./log", () => ({ logCalendar: vi.fn() }));
vi.mock("./channels", () => ({
  ensureChannel: vi.fn(async () => ({ status: "unchanged", replaced: null })),
  stopChannels: vi.fn(),
}));
vi.mock("./tokens", () => ({
  StaleCredentialsError: class StaleCredentialsError extends Error {},
  withAccessToken: (
    _deps: unknown,
    _connectionId: string,
    run: (token: string) => unknown,
  ) => run("token"),
}));

// A sync pass is `stale` (budget_exceeded, resumed by the next pass) only
// when its deadline is what stopped it, as the deadline mechanism says
// (DeadlineExceededError): never because the clock has passed the
// deadline by the time an error is examined.

const BUDGET = 25_000;

function setup(listEvents: () => Promise<never>) {
  const releases: { p_outcome: string; p_error: string | null }[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "calendar_claim_sync") {
      return {
        data: {
          claimed: true,
          claimId: "claim-1",
          calendarId: "cal-1",
          businessId: "b-1",
          connectionId: "k-1",
          connectionGeneration: "g-1",
          provider: "google",
          providerCalendarId: "primary",
          timezone: "UTC",
          syncToken: "sync-1",
          windowEnd: new Date(Date.now() + 399 * 86_400_000).toISOString(),
          fullInProgress: false,
          channelId: null,
          channelExpiresAt: null,
        },
        error: null,
      };
    }
    if (name === "calendar_release_sync") {
      releases.push(args as (typeof releases)[number]);
      return { data: false, error: null };
    }
    return { data: null, error: null };
  });
  const deps = {
    admin: { rpc },
    env: {},
    provider: () => ({ listEvents }),
  } as unknown as CalendarDeps;
  return { deps, releases };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("inbound sync: deadline or real failure", () => {
  it("a real provider failure a millisecond before the pass deadline, examined after the clock passed it, is an error (never budget_exceeded)", async () => {
    const start = Date.now();
    const { deps, releases } = setup(
      () =>
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            // Fails at T − 1; examined once the clock reads T + 1.
            vi.setSystemTime(start + BUDGET + 1);
            reject(new CalendarProviderError("bad_request", 400, "sentinel"));
          }, BUDGET - 1);
        }),
    );
    const sync = syncCalendar(deps, "cal-1", { budgetMs: BUDGET });
    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(await sync).toBe("error");
    expect(releases).toEqual([
      expect.objectContaining({
        p_outcome: "error",
        p_error: "provider_bad_request",
      }),
    ]);
  });

  it("the deadline first (the provider call reports its own deadline): stale, budget_exceeded", async () => {
    const { deps, releases } = setup(
      () =>
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new DeadlineExceededError()), BUDGET);
        }),
    );
    const sync = syncCalendar(deps, "cal-1", { budgetMs: BUDGET });
    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(await sync).toBe("stale");
    expect(releases).toEqual([
      expect.objectContaining({
        p_outcome: "stale",
        p_error: "budget_exceeded",
      }),
    ]);
  });

  it("a deadline timer firing a little before the clock reads the deadline is still the deadline", async () => {
    const { deps } = setup(
      () =>
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new DeadlineExceededError()), BUDGET - 2);
        }),
    );
    const sync = syncCalendar(deps, "cal-1", { budgetMs: BUDGET });
    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(await sync).toBe("stale");
  });

  it("classifies by identity: the deadline's own error, or a real one, whatever the clock", () => {
    expect(failureOf(new DeadlineExceededError())).toEqual({
      outcome: "stale",
      code: "budget_exceeded",
    });
    // Same kind, but not the deadline's: a real unavailability.
    expect(
      failureOf(new CalendarProviderError("unavailable", null, "attempts")),
    ).toEqual({ outcome: "error", code: "provider_unavailable" });
  });
});

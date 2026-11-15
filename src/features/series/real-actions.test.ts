import { beforeEach, describe, expect, it, vi } from "vitest";

import { realSeriesActions } from "./real-actions";

// The adapter between Cloud's Server Actions and the planner's contract.

const { actions } = vi.hoisted(() => ({
  actions: { previewSeriesAction: vi.fn(), commitSeriesAction: vi.fn() },
}));
vi.mock("@/features/appointment-series/actions", () => ({
  previewSeriesAction: (...args: unknown[]) =>
    actions.previewSeriesAction(...args),
  commitSeriesAction: (...args: unknown[]) =>
    actions.commitSeriesAction(...args),
}));

beforeEach(() => {
  Object.values(actions).forEach((mock) => mock.mockReset());
});

describe("realSeriesActions", () => {
  it("names the dates taken meanwhile from fieldErrors.keys", async () => {
    actions.commitSeriesAction.mockResolvedValue({
      ok: false,
      error: {
        code: "calendar_conflict",
        message: "never shown",
        fieldErrors: { keys: ["o2", "o4"] },
      },
    });
    const result = await realSeriesActions.commit({
      requestId: "00000000-0000-4000-8000-000000000001",
      previewVersion: "v",
      selected: [],
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "calendar_conflict", keys: ["o2", "o4"] },
    });
  });

  it("passes an answer through unchanged", async () => {
    actions.commitSeriesAction.mockResolvedValue({
      ok: true,
      data: { seriesId: "s", appointmentIds: ["a", "b"] },
    });
    const result = await realSeriesActions.commit({
      requestId: "00000000-0000-4000-8000-000000000001",
      previewVersion: "v",
      selected: [],
    });
    expect(result).toEqual({
      ok: true,
      data: { seriesId: "s", appointmentIds: ["a", "b"] },
    });
  });
});

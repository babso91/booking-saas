import { beforeEach, describe, expect, it, vi } from "vitest";

import { realCampaignActions } from "./real-actions";

// The adapter between Cloud's campaign actions and the screens.

const { actions } = vi.hoisted(() => ({
  actions: {
    estimateCampaignAction: vi.fn(),
    scheduleCampaignAction: vi.fn(),
    readCampaignAction: vi.fn(),
    setCampaignStateAction: vi.fn(),
  },
}));
vi.mock("@/features/growth-server/actions", () =>
  Object.fromEntries(
    Object.entries(actions).map(([name, mock]) => [
      name,
      (...args: unknown[]) => mock(...args),
    ]),
  ),
);

beforeEach(() => {
  Object.values(actions).forEach((mock) => mock.mockReset());
});

describe("realCampaignActions", () => {
  it("reads a campaign by its id", async () => {
    actions.readCampaignAction.mockResolvedValue({
      ok: true,
      data: { campaignId: "c1" },
    });
    const result = await realCampaignActions.read("c1");
    expect(actions.readCampaignAction).toHaveBeenCalledWith({
      campaignId: "c1",
    });
    expect(result).toEqual({ ok: true, data: { campaignId: "c1" } });
  });

  it("keeps an error's code only", async () => {
    actions.scheduleCampaignAction.mockResolvedValue({
      ok: false,
      error: { code: "estimate_stale", message: "never shown" },
    });
    const result = await realCampaignActions.schedule({
      estimateId: "e1",
      maxUnits: 10,
      requestId: "r1",
    });
    expect(result).toEqual({ ok: false, error: { code: "estimate_stale" } });
  });
});

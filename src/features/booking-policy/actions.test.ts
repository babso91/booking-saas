import { beforeEach, describe, expect, it, vi } from "vitest";

import { setCancellationPolicyAction } from "./actions";

const state = vi.hoisted(() => ({
  role: "owner",
  rpc: vi.fn(),
  single: vi.fn(),
  from: vi.fn(),
}));
const BUSINESS = "11111111-1111-4111-8111-111111111111";
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    rpc: state.rpc,
    from: state.from,
  }),
}));
vi.mock("@/features/businesses/data/business-context", () => ({
  getBusinessContext: async () => ({ businessId: BUSINESS, role: state.role }),
}));

beforeEach(() => {
  state.role = "owner";
  state.rpc.mockReset().mockResolvedValue({
    data: { cancellationLeadMinutes: 0, rescheduleLeadMinutes: 720 },
    error: null,
  });
  state.single
    .mockReset()
    .mockResolvedValue({ data: { reschedule_lead_minutes: 720 }, error: null });
  state.from.mockReset().mockReturnValue({
    select: () => ({ eq: () => ({ single: state.single }) }),
  });
});

describe("cancellation policy ownership", () => {
  it("preserves the separate rescheduling setting", async () => {
    expect(
      await setCancellationPolicyAction({
        businessId: BUSINESS,
        cancellationLeadMinutes: 0,
      }),
    ).toMatchObject({ ok: true });
    expect(state.rpc).toHaveBeenCalledWith("set_booking_policy", {
      p_business_id: BUSINESS,
      p_cancellation_lead_minutes: 0,
      p_reschedule_lead_minutes: 720,
    });
  });
  it("refuses a form left open for another salon", async () => {
    expect(
      await setCancellationPolicyAction({
        businessId: "22222222-2222-4222-8222-222222222222",
        cancellationLeadMinutes: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(state.from).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("refuses a practitioner before any settings read or write", async () => {
    state.role = "practitioner";
    expect(
      await setCancellationPolicyAction({
        businessId: BUSINESS,
        cancellationLeadMinutes: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(state.from).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

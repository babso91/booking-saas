// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { recordOperation } from "./operation-store";
import { usePendingOperations } from "./pending-operations";

// The hook alone, never remounted: its snapshot belongs to the context it
// was read for, and is never shown for another one.

vi.mock("@/features/loyalty/actions/loyalty", () => ({
  adjustPointsAction: vi.fn(),
  redeemRewardAction: vi.fn(),
}));

const CLIENT = "20000000-0000-4000-8000-000000000001";
const A = { userId: "user-a", businessId: "business-a", clientId: CLIENT };
const B = { ...A, userId: "user-b" };
const settle = () =>
  act(async () => {
    for (let tick = 0; tick < 10; tick += 1)
      await new Promise((resolve) => setImmediate(resolve));
  });

describe("usePendingOperations across a context change", () => {
  it("shows nothing of A as soon as the context is B, before B's read answers", async () => {
    await recordOperation(A, {
      kind: "credit",
      command: { clientId: CLIENT, pointsDelta: 10, reason: "A" },
    });
    const { result, rerender } = renderHook(
      (scope: typeof A) => usePendingOperations(scope),
      { initialProps: A },
    );
    await settle();
    expect(result.current.operations).toHaveLength(1);

    rerender(B);
    // Same hook instance, same render: no operation of A, not "ready".
    expect(result.current.operations).toEqual([]);
    expect(result.current.status).toBe("loading");
    await settle();
    expect(result.current.status).toBe("ready");
    expect(result.current.operations).toEqual([]);

    // Back to A, same instance: A's operation is still there.
    rerender(A);
    await settle();
    expect(result.current.operations.map((item) => item.userId)).toEqual([
      "user-a",
    ]);
  });
});

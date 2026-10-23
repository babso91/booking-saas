// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useHistory } from "./history";

afterEach(() => vi.useRealTimers());

describe("studio undo / redo", () => {
  it("undoes and redoes steps; a new change clears what could be redone", () => {
    const { result } = renderHook(() => useHistory("a"));
    act(() => result.current.set("b"));
    act(() => result.current.set("c"));
    act(() => result.current.undo());
    expect(result.current.value).toBe("b");
    act(() => result.current.redo());
    expect(result.current.value).toBe("c");
    act(() => result.current.undo());
    act(() => result.current.set("d"));
    expect(result.current.canRedo).toBe(false);
  });

  it("a gesture on one control (dragging, typing) is one step; a pause starts another", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHistory({ x: 50 }));
    for (const x of [52, 55, 60, 64])
      act(() => result.current.set({ x }, "focal"));
    vi.advanceTimersByTime(2000);
    act(() => result.current.set({ x: 70 }, "focal"));
    act(() => result.current.undo());
    expect(result.current.value).toEqual({ x: 64 });
    act(() => result.current.undo());
    expect(result.current.value).toEqual({ x: 50 });
    expect(result.current.canUndo).toBe(false);
  });
});

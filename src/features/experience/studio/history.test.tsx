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

describe("a change that lands late (Codex review of #50)", () => {
  it("update applies to the latest value, never to the one a slow caller saw", async () => {
    const { withPhoto } = await import("./studio");
    const { universes } = await import("./universes");
    const start = universes.mila.config;
    const { result } = renderHook(() => useHistory(start));
    // A photo upload starts; meanwhile she renames her studio.
    act(() =>
      result.current.set({
        ...result.current.value,
        brand: { ...result.current.value.brand, name: "Atelier Nouveau" },
      }),
    );
    // The upload completes: the photo goes into the draft as it is now.
    act(() =>
      result.current.update((current) =>
        withPhoto(current, "cover", "photo-1"),
      ),
    );
    expect(result.current.value.brand.name).toBe("Atelier Nouveau");
    expect(result.current.value.content.cover).toBe("photo-1");
    // One undo step for the photo, then the rename.
    act(() => result.current.undo());
    expect(result.current.value.content.cover).toBe(start.content.cover);
    expect(result.current.value.brand.name).toBe("Atelier Nouveau");
  });
});

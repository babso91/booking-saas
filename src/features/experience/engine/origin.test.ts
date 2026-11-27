// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { circleOf, insetOf, markReturn, triggerOf } from "./origin";

afterEach(() => {
  document.body.innerHTML = "";
});

const box = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  }) as DOMRect;

describe("origin: what opens grows out of what was tapped", () => {
  it("prefers the focused button, else the one pressed, if still there", () => {
    document.body.innerHTML = `<button id="a">A</button><button id="b">B</button>`;
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    expect(triggerOf(b)).toBe(b); // Safari: a click does not focus
    a.focus();
    expect(triggerOf(b)).toBe(a);
    a.blur();
    b.remove();
    expect(triggerOf(b)).toBeNull();
  });

  it("starts from the tapped box, as an inset or a circle covering the screen", () => {
    vi.stubGlobal("innerWidth", 400);
    vi.stubGlobal("innerHeight", 800);
    expect(insetOf(box(20, 600, 100, 40))).toBe(
      "inset(600px 280px 160px 20px round 16px)",
    );
    expect(circleOf(box(350, 10, 20, 20), false)).toBe(
      "circle(0px at 360px 20px)",
    );
    // From the top right corner, it must reach the bottom left one.
    expect(circleOf(box(350, 10, 20, 20), true)).toBe(
      `circle(${Math.ceil(Math.hypot(360, 780))}px at 360px 20px)`,
    );
    vi.unstubAllGlobals();
  });

  it("gives the focus back to where she was", () => {
    document.body.innerHTML = `<button id="a">A</button>`;
    const a = document.getElementById("a")!;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never;
    markReturn(a);
    expect(document.activeElement).toBe(a);
    expect(() => markReturn(null)).not.toThrow();
  });
});

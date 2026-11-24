// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { FractureLink } from "./fracture-link";

afterEach(() => {
  cleanup();
  push.mockReset();
});

describe("FractureLink", () => {
  it("is a plain link where the fracture cannot run (no WebGL here)", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
    render(<FractureLink href="/login">Se connecter</FractureLink>);
    const link = screen.getByRole("link", { name: "Se connecter" });
    expect(link.getAttribute("href")).toBe("/login");
    // jsdom has no WebGL: the click is left to the link itself.
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("is a plain link when motion is reduced", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never;
    render(<FractureLink href="/login">Se connecter</FractureLink>);
    const link = screen.getByRole("link", { name: "Se connecter" });
    fireEvent.pointerEnter(link);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector("body > div[aria-hidden]")).toBeNull();
  });
});

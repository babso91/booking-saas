// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "@/features/agenda/components/app-shell";
import { defaultAppearance } from "@/features/appearance/appearance";
import { AppearanceProvider } from "@/features/appearance/components/appearance-provider";
import { AppearanceSettings } from "@/features/appearance/components/appearance-settings";

vi.mock(
  "next/navigation",
  async () =>
    (await import("../../../../tests/support/next-router")).nextNavigationMock,
);
vi.mock("@/features/auth/actions/auth", () => ({ signOutAction: vi.fn() }));

// After hydration, not in the first HTML: changing style replaces the frame,
// the applied attribute and the cookie, and leaves nothing of the other one.

const frame = () => document.querySelector(".ecrin-ground");
const style = () => document.documentElement.getAttribute("data-style");
const cookie = () =>
  document.cookie
    .split("; ")
    .find((part) => part.startsWith("dash_appearance="))
    ?.split(".")
    .at(-1);

describe("changing style in the page", () => {
  it("Écrin → Studio → Classique → Écrin, with no leak in either direction", async () => {
    const user = userEvent.setup();
    // The cookie's path is /app.
    window.history.pushState({}, "", "/app/settings/appearance");
    render(
      <AppearanceProvider initial={{ ...defaultAppearance, style: "ecrin" }}>
        <AppShell
          business={{ name: "Atelier Maëlys", slug: "atelier-maelys" }}
          current="appearance"
        >
          <AppearanceSettings />
        </AppShell>
      </AppearanceProvider>,
    );
    expect(style()).toBe("ecrin");
    expect(frame()).not.toBeNull();

    await user.click(screen.getByRole("radio", { name: /Studio/ }));
    expect(style()).toBe("studio");
    expect(cookie()).toBe("studio");
    expect(frame()).toBeNull();

    await user.click(screen.getByRole("radio", { name: /Classique/ }));
    expect(style()).toBe("classique");
    expect(cookie()).toBe("classique");
    expect(frame()).toBeNull();

    await user.click(screen.getByRole("radio", { name: /Écrin/ }));
    expect(style()).toBe("ecrin");
    expect(cookie()).toBe("ecrin");
    expect(frame()).not.toBeNull();
  });
});

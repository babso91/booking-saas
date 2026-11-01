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
// and the applied attribute, leaves nothing of the other one, and keeps her
// focus on what she chose.

const frame = () => document.querySelector(".ecrin-ground");
const style = () => document.documentElement.getAttribute("data-style");
const chosen = (name: RegExp) => screen.getByRole("radio", { name });

describe("changing style in the page", () => {
  it("Écrin → Studio → Classique → Écrin, with no leak in either direction", async () => {
    const user = userEvent.setup();
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
    expect(document.activeElement).toBe(chosen(/Studio/));
    expect(frame()).toBeNull();

    await user.click(screen.getByRole("radio", { name: /Classique/ }));
    expect(style()).toBe("classique");
    expect(document.activeElement).toBe(chosen(/Classique/));
    expect(frame()).toBeNull();

    await user.click(screen.getByRole("radio", { name: /Écrin/ }));
    expect(style()).toBe("ecrin");
    expect(document.activeElement).toBe(chosen(/Écrin/));
    expect(frame()).not.toBeNull();
    // This device keeps nothing of its own any more.
    expect(document.cookie).not.toContain("dash_appearance");
  });
});

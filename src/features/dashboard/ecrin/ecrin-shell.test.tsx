// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "@/features/agenda/components/app-shell";
import { defaultAppearance } from "@/features/appearance/appearance";
import { AppearanceProvider } from "@/features/appearance/components/appearance-provider";

vi.mock(
  "next/navigation",
  async () =>
    (await import("../../../../tests/support/next-router")).nextNavigationMock,
);
vi.mock("@/features/auth/actions/auth", () => ({ signOutAction: vi.fn() }));

const business = { name: "Atelier Maëlys", slug: "atelier-maelys" };

function renderEcrin(current?: "today" | "hours") {
  return render(
    <AppearanceProvider initial={{ ...defaultAppearance, style: "ecrin" }}>
      <AppShell business={business} current={current}>
        <p>contenu</p>
      </AppShell>
    </AppearanceProvider>,
  );
}

describe("the Écrin frame", () => {
  it("the same rooms in one capsule, the current one marked", () => {
    renderEcrin("today");
    const nav = within(
      screen.getByRole("navigation", { name: "Navigation principale" }),
    );
    const today = nav.getByRole("link", { name: "Aujourd’hui" });
    expect(today.getAttribute("href")).toBe("/app/today");
    expect(today.getAttribute("aria-current")).toBe("page");
    expect(nav.getByRole("link", { name: "Agenda" }).getAttribute("href")).toBe(
      "/app",
    );
    expect(screen.getByText("contenu")).toBeTruthy();
  });

  it("the monogram says when she is in a room of the sheet", () => {
    renderEcrin("hours");
    const monogram = screen.getByRole("button", {
      name: "Atelier Maëlys : réglages et compte",
    });
    expect(monogram.textContent).toBe("AM");
    expect(monogram.getAttribute("aria-current")).toBe("page");
  });

  // jsdom applies no CSS: what each width shows is read from the classes.
  const visible = (element: Element, wide: boolean) => {
    const classes = element.className.split(/\s+/);
    return wide ? !classes.includes("md:hidden") : !classes.includes("hidden");
  };

  it.each([false, true])(
    "every room is reachable (wide = %s)",
    async (wide) => {
      const user = userEvent.setup();
      renderEcrin("today");
      const reachable = new Set(
        within(
          screen.getByRole("navigation", { name: "Navigation principale" }),
        )
          .getAllByRole("link")
          .filter((link) => visible(link, wide))
          .map((link) => link.getAttribute("href")),
      );
      await user.click(
        screen.getByRole("button", {
          name: "Atelier Maëlys : réglages et compte",
        }),
      );
      const sheet = within(screen.getByRole("dialog"));
      sheet
        .getAllByRole("link")
        .filter((link) => visible(link, wide))
        .forEach((link) => reachable.add(link.getAttribute("href")));
      expect(
        sheet.getByRole("button", { name: /Se déconnecter/ }),
      ).toBeTruthy();
      expect([...reachable].sort()).toEqual(
        [
          "/app",
          "/app/clients",
          "/app/loyalty",
          "/app/services",
          "/app/settings/appearance",
          "/app/settings/calendar",
          "/app/settings/hours",
          "/app/today",
        ].sort(),
      );
    },
  );
});

describe("Écrin focus", () => {
  // Her stone can be any colour: focus is drawn with the accent, readable by
  // construction, never with the raw signature.
  const here = join(process.cwd(), "src/features/dashboard/ecrin");
  const files = readdirSync(here).filter(
    (file) => file.endsWith(".tsx") && !file.includes(".test."),
  );
  it.each(files)("%s never draws focus with the signature", (file) => {
    expect(readFileSync(join(here, file), "utf8")).not.toMatch(
      /outline-signature|ring-signature/,
    );
  });
});

// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "@/features/agenda/components/app-shell";
import { defaultAppearance } from "@/features/appearance/appearance";
import { AppearanceProvider } from "@/features/appearance/components/appearance-provider";

import { initialsOf } from "../sections";

vi.mock(
  "next/navigation",
  async () =>
    (await import("../../../../tests/support/next-router")).nextNavigationMock,
);
vi.mock("@/features/auth/actions/auth", () => ({ signOutAction: vi.fn() }));

const business = { name: "Atelier Maëlys", slug: "atelier-maelys" };

function renderIn(style: "classique" | "studio", current?: "today" | "hours") {
  return render(
    <AppearanceProvider initial={{ ...defaultAppearance, style }}>
      <AppShell business={business} current={current}>
        <p>contenu</p>
      </AppShell>
    </AppearanceProvider>,
  );
}

describe("the frame follows her style", () => {
  it("Classique: the sidebar and tab bar she always had", () => {
    renderIn("classique");
    expect(screen.getByRole("button", { name: "Compte" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Aujourd’hui" })).toBeNull();
  });

  it("Studio: the same rooms in a dock, today first, the current one marked", () => {
    renderIn("studio", "today");
    const dock = within(
      screen.getByRole("navigation", { name: "Navigation principale" }),
    );
    const today = dock.getByRole("link", { name: "Aujourd’hui" });
    expect(today.getAttribute("href")).toBe("/app/today");
    expect(today.getAttribute("aria-current")).toBe("page");
    expect(
      dock.getByRole("link", { name: "Agenda" }).getAttribute("href"),
    ).toBe("/app");
    expect(
      dock.getByRole("link", { name: "Clientes" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(screen.getByText("contenu")).toBeTruthy();
  });

  it("Studio: everything else in one sheet, from her monogram or « Plus »", async () => {
    const user = userEvent.setup();
    renderIn("studio", "hours");
    const monogram = screen.getByRole("button", {
      name: "Atelier Maëlys : réglages et compte",
    });
    expect(monogram.textContent).toBe("AM");
    // She is in a room of the sheet: the monogram says so.
    expect(monogram.getAttribute("aria-current")).toBe("page");

    await user.click(screen.getByRole("button", { name: "Plus" }));
    const sheet = within(screen.getByRole("dialog"));
    expect(
      sheet
        .getByRole("link", { name: /Horaires/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      sheet.getByRole("link", { name: /Apparence/ }).getAttribute("href"),
    ).toBe("/app/settings/appearance");
    expect(sheet.getByText(/\/b\/atelier-maelys/)).toBeTruthy();
    expect(sheet.getByRole("button", { name: /Se déconnecter/ })).toBeTruthy();
  });
});

describe("initialsOf", () => {
  it.each([
    ["Atelier Maëlys", "AM"],
    ["Studio Mila", "SM"],
    ["Inès", "IN"],
    ["l’Atelier de Jade", "LA"],
    ["  ", "·"],
    ["Éclat — Paris", "ÉP"],
  ])("%s → %s", (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });
});

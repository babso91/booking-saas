// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "./app-shell";

vi.mock(
  "next/navigation",
  async () =>
    (await import("../../../../tests/support/next-router")).nextNavigationMock,
);
vi.mock("@/features/auth/actions/auth", () => ({ signOutAction: vi.fn() }));

describe("AppShell", () => {
  it("links only to real destinations and marks upcoming sections as such", () => {
    render(
      <AppShell business={{ name: "Studio Mila", slug: "studio-mila" }}>
        <p>contenu</p>
      </AppShell>,
    );

    const agendaLinks = screen.getAllByRole("link", { name: /Agenda/ });
    agendaLinks.forEach((link) => {
      expect(link.getAttribute("href")).toBe("/app");
      expect(link.getAttribute("aria-current")).toBe("page");
    });
    expect(
      screen.queryByRole("link", { name: /Clientes|Fidélité|Paramètres/ }),
    ).toBeNull();
    expect(screen.getAllByText("Bientôt").length).toBeGreaterThan(0);
    expect(screen.getByText("contenu")).toBeTruthy();
  });

  it("opens the account panel from the mobile tab bar", async () => {
    const user = userEvent.setup();
    render(
      <AppShell business={{ name: "Studio Mila", slug: "studio-mila" }}>
        <p>contenu</p>
      </AppShell>,
    );

    await user.click(screen.getByRole("button", { name: "Compte" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("link", { name: /\/b\/studio-mila/ })).toBeTruthy();
    expect(dialog.getByRole("button", { name: /Se déconnecter/ })).toBeTruthy();
  });

  it("leads to the Google Calendar settings, marked as the current page there", async () => {
    const user = userEvent.setup();
    render(
      <AppShell
        business={{ name: "Studio Mila", slug: "studio-mila" }}
        current="calendar"
      >
        <p>contenu</p>
      </AppShell>,
    );

    const calendarLink = screen.getByRole("link", { name: /Google Calendar/ });
    expect(calendarLink.getAttribute("href")).toBe("/app/settings/calendar");
    expect(calendarLink.getAttribute("aria-current")).toBe("page");
    screen
      .getAllByRole("link", { name: /Agenda/ })
      .forEach((link) => expect(link.getAttribute("aria-current")).toBeNull());

    // Phones: from the account panel.
    await user.click(screen.getByRole("button", { name: "Compte" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(
      dialog
        .getByRole("link", { name: /Google Calendar/ })
        .getAttribute("href"),
    ).toBe("/app/settings/calendar");
  });
});

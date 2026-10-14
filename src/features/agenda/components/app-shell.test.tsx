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
    screen.getAllByRole("link", { name: /Clientes/ }).forEach((link) => {
      expect(link.getAttribute("href")).toBe("/app/clients");
      expect(link.getAttribute("aria-current")).toBeNull();
    });
    expect(
      screen.queryByRole("link", { name: /Fidélité|Paramètres/ }),
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
    expect(
      dialog.getByRole("link", { name: /Horaires/ }).getAttribute("href"),
    ).toBe("/app/settings/hours");
    // The booking page address is shown, marked as coming soon, not linked.
    expect(dialog.getByText(/\/b\/studio-mila/)).toBeTruthy();
    expect(dialog.queryByRole("link", { name: /\/b\// })).toBeNull();
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

  it("marks Clientes as the current page in the customer screens", () => {
    render(
      <AppShell
        business={{ name: "Studio Mila", slug: "studio-mila" }}
        current="clients"
      >
        <p>contenu</p>
      </AppShell>,
    );
    const links = screen.getAllByRole("link", { name: /Clientes/ });
    expect(links).toHaveLength(2); // sidebar and phone tab bar
    links.forEach((link) =>
      expect(link.getAttribute("aria-current")).toBe("page"),
    );
    screen
      .getAllByRole("link", { name: /Agenda/ })
      .forEach((link) => expect(link.getAttribute("aria-current")).toBeNull());
  });
});

describe("services and hours", () => {
  it("are reachable from the sidebar and the phone tab bar, marked as current there", () => {
    const { unmount } = render(
      <AppShell
        business={{ name: "Studio Mila", slug: "studio-mila" }}
        current="services"
      >
        <p>contenu</p>
      </AppShell>,
    );
    const services = screen.getAllByRole("link", { name: /Prestations/ });
    // Sidebar and phone tab bar.
    expect(services).toHaveLength(2);
    services.forEach((link) => {
      expect(link.getAttribute("href")).toBe("/app/services");
      expect(link.getAttribute("aria-current")).toBe("page");
    });
    unmount();

    render(
      <AppShell
        business={{ name: "Studio Mila", slug: "studio-mila" }}
        current="hours"
      >
        <p>contenu</p>
      </AppShell>,
    );
    const hours = screen.getByRole("link", { name: /Horaires/ });
    expect(hours.getAttribute("href")).toBe("/app/settings/hours");
    expect(hours.getAttribute("aria-current")).toBe("page");
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WaitlistSection } from "./waitlist-section";

// Her waitlist switch, with the Server Actions mocked at their boundary.

const { actions } = vi.hoisted(() => ({
  actions: {
    getBookingSettingsAction: vi.fn(),
    setWaitlistEnabledAction: vi.fn(),
  },
}));

vi.mock("@/features/availability/actions/schedule", () => ({
  getBookingSettingsAction: (...args: unknown[]) =>
    actions.getBookingSettingsAction(...args),
}));
vi.mock("@/features/booking-policy/actions", () => ({
  setWaitlistEnabledAction: (...args: unknown[]) =>
    actions.setWaitlistEnabledAction(...args),
}));

const ok = <T,>(data: T) => ({ ok: true as const, data });
const settings = (waitlistEnabled: boolean) =>
  ok({
    currency: "EUR",
    slotIntervalMinutes: 15,
    bufferMinutes: 0,
    minimumBookingNoticeMinutes: 60,
    maximumBookingAdvanceDays: 60,
    cancellationLeadMinutes: null,
    rescheduleLeadMinutes: null,
    waitlistEnabled,
  });

beforeEach(() => {
  Object.values(actions).forEach((mock) => mock.mockReset());
});
afterEach(cleanup);

describe("WaitlistSection", () => {
  it("cannot be opened while no email can leave, and says why", async () => {
    actions.getBookingSettingsAction.mockResolvedValue(settings(false));
    render(<WaitlistSection emailReady={false} />);
    const toggle = (await screen.findByRole("switch", {
      name: "Liste d’attente ouverte",
    })) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(
      screen.getByText("Pas encore disponible pour ton espace"),
    ).toBeTruthy();
  });

  it("opens with emails ready, and says that closing stops the offers", async () => {
    actions.getBookingSettingsAction.mockResolvedValue(settings(false));
    actions.setWaitlistEnabledAction.mockResolvedValue(ok({ enabled: true }));
    render(<WaitlistSection emailReady />);
    const toggle = (await screen.findByRole("switch", {
      name: "Liste d’attente ouverte",
    })) as HTMLInputElement;
    fireEvent.click(toggle);
    expect(
      await screen.findByText("La fermer arrête aussi les offres en cours."),
    ).toBeTruthy();
    expect(actions.setWaitlistEnabledAction).toHaveBeenCalledWith({
      enabled: true,
    });
    expect(toggle.checked).toBe(true);
  });

  it("an open list can still be closed when emails stop", async () => {
    actions.getBookingSettingsAction.mockResolvedValue(settings(true));
    render(<WaitlistSection emailReady={false} />);
    const toggle = (await screen.findByRole("switch", {
      name: "Liste d’attente ouverte",
    })) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
  });
});

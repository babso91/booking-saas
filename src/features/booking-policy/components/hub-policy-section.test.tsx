// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bookingPolicySchema } from "../schemas";
import { HubPolicySection, leadLabel } from "./hub-policy-section";

// Her Hub policy, from what the professional sees and does. The Server
// Actions are mocked at their module boundary with their real result
// shapes; every command sent is checked against the action's zod schema.

const { actions } = vi.hoisted(() => ({
  actions: {
    getBookingSettingsAction: vi.fn(),
    setBookingPolicyAction: vi.fn(),
  },
}));

vi.mock("@/features/availability/actions/schedule", () => ({
  getBookingSettingsAction: (...args: unknown[]) =>
    actions.getBookingSettingsAction(...args),
}));
vi.mock("@/features/booking-policy/actions", () => ({
  setBookingPolicyAction: (...args: unknown[]) =>
    actions.setBookingPolicyAction(...args),
}));

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string) => ({
  ok: false as const,
  error: { code, message: "backend text never shown" },
});

const settings = (
  cancellationLeadMinutes: number | null,
  rescheduleLeadMinutes: number | null,
) => ({
  currency: "EUR",
  slotIntervalMinutes: 15,
  bufferMinutes: 0,
  minimumBookingNoticeMinutes: 60,
  maximumBookingAdvanceDays: 60,
  cancellationLeadMinutes,
  rescheduleLeadMinutes,
});

beforeEach(() => {
  Object.values(actions).forEach((mock) => mock.mockReset());
});
afterEach(cleanup);

describe("HubPolicySection", () => {
  it("shows never by default, and saves the deadlines she picks", async () => {
    actions.getBookingSettingsAction.mockResolvedValue(
      ok(settings(null, null)),
    );
    actions.setBookingPolicyAction.mockImplementation(async (input) =>
      ok(bookingPolicySchema.parse(input)),
    );
    render(<HubPolicySection />);

    const cancel = (await screen.findByLabelText(
      "Annuler",
    )) as HTMLSelectElement;
    const move = screen.getByLabelText("Déplacer") as HTMLSelectElement;
    expect(cancel.selectedOptions[0]!.textContent).toBe(
      "Jamais, elles me contactent",
    );
    const save = screen.getByRole("button", { name: "Enregistrer ces règles" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(cancel, { target: { value: "1440" } });
    fireEvent.change(move, { target: { value: "0" } });
    fireEvent.click(save);

    expect(await screen.findByText("Enregistré")).toBeTruthy();
    expect(actions.setBookingPolicyAction).toHaveBeenCalledWith({
      cancellationLeadMinutes: 1440,
      rescheduleLeadMinutes: 0,
    });
    expect(
      screen.getByText(
        /S’applique aux rendez-vous pris à partir de maintenant/,
      ),
    ).toBeTruthy();
  });

  it("says a refused role plainly, and changes nothing", async () => {
    actions.getBookingSettingsAction.mockResolvedValue(
      ok(settings(null, null)),
    );
    actions.setBookingPolicyAction.mockResolvedValue(fail("forbidden"));
    render(<HubPolicySection />);

    fireEvent.change(await screen.findByLabelText("Annuler"), {
      target: { value: "120" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer ces règles" }),
    );

    expect(
      await screen.findByText("Réservé à la propriétaire ou à une admin"),
    ).toBeTruthy();
    expect(screen.getByText(/Rien n’a été modifié/)).toBeTruthy();
  });

  it("keeps a deadline set elsewhere visible instead of dropping it", async () => {
    actions.getBookingSettingsAction.mockResolvedValue(ok(settings(90, 2_160)));
    render(<HubPolicySection />);

    const cancel = (await screen.findByLabelText(
      "Annuler",
    )) as HTMLSelectElement;
    expect(cancel.selectedOptions[0]!.textContent).toBe("Jusqu’à 90 min avant");
    expect(leadLabel(2_160)).toBe("Jusqu’à 36 h avant");
  });

  it("offers a retry when the settings cannot be read", async () => {
    actions.getBookingSettingsAction
      .mockResolvedValueOnce(fail("network"))
      .mockResolvedValueOnce(ok(settings(null, null)));
    render(<HubPolicySection />);

    fireEvent.click(await screen.findByRole("button", { name: "Réessayer" }));
    expect(await screen.findByLabelText("Annuler")).toBeTruthy();
  });
});

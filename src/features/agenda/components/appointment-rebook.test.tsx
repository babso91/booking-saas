// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgendaServicesDto } from "@/features/agenda/data/lookups";

import { AppointmentForm } from "./appointment-form";

// Taking an appointment again (M2-R05): the creation form prepared with
// the same client and service. Never its note, price or duration: the
// server computes them as they are now.

const actions = vi.hoisted(() => ({
  createAppointmentAction: vi.fn(),
  updateAppointmentAction: vi.fn(),
  searchAgendaClientsAction: vi.fn(),
}));
vi.mock("@/features/agenda/actions/agenda", () => actions);

afterEach(cleanup);
beforeEach(() => {
  actions.createAppointmentAction.mockReset();
});

const services: AgendaServicesDto = {
  services: [
    {
      id: "s-lift",
      name: "Rehaussement de cils",
      durationMinutes: 75,
      priceCents: 6500,
      options: [],
    } as never,
  ],
  bufferMinutes: 0,
  currency: "EUR",
};

const show = (serviceId: string, serviceName: string) =>
  render(
    <AppointmentForm
      mode={{
        kind: "create",
        date: "2026-11-20",
        time: "10:00",
        from: {
          client: { id: "c-lea", displayName: "Léa Fontaine" },
          serviceId,
          serviceName,
        },
      }}
      services={{ status: "ready", data: services }}
      zone={null}
      onSaved={() => undefined}
      onCancel={() => undefined}
    />,
  );

describe("taking an appointment again", () => {
  it("prepared with the same client and service, at today's price; no note copied", async () => {
    actions.createAppointmentAction.mockResolvedValue({
      ok: true,
      data: { appointment: { id: "new" } },
    });
    show("s-lift", "Rehaussement de cils");
    expect(
      screen.getByText(
        /Nouveau rendez-vous pour Léa Fontaine : même prestation/,
      ),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Prestation") as HTMLSelectElement).value,
    ).toBe("s-lift");
    expect(screen.getByText(/1 h 15 · 65,00\s€/)).toBeTruthy();

    fireEvent.submit(
      screen
        .getByRole("button", { name: /Ajouter|Enregistrer|Créer/ })
        .closest("form")!,
    );
    await waitFor(() =>
      expect(actions.createAppointmentAction).toHaveBeenCalledTimes(1),
    );
    const sent = actions.createAppointmentAction.mock.calls[0]![0];
    expect(sent).toMatchObject({
      serviceId: "s-lift",
      client: { type: "existing", clientId: "c-lea" },
    });
    expect(sent.internalNotes).toBeUndefined();
  });

  it("its service is no longer offered: said, and she chooses another", () => {
    show("s-gone", "Pose cil à cil");
    expect(screen.getByText(/Pose cil à cil n’est plus proposée/)).toBeTruthy();
    expect(
      (screen.getByLabelText("Prestation") as HTMLSelectElement).value,
    ).toBe("");
    fireEvent.submit(screen.getByLabelText("Prestation").closest("form")!);
    expect(actions.createAppointmentAction).not.toHaveBeenCalled();
  });
});

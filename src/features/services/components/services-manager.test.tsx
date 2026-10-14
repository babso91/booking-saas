// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceView } from "../client/service-form";
import { ServicesManager } from "./services-manager";

// The services screen, from what the professional sees and does. The
// existing Server Actions are mocked at their module boundary with their
// real result shapes (ActionResult<ServiceDto…>).

const { actions } = vi.hoisted(() => ({
  actions: {
    listServicesAction: vi.fn(),
    createServiceAction: vi.fn(),
    updateServiceAction: vi.fn(),
    setServiceActiveAction: vi.fn(),
    reorderServicesAction: vi.fn(),
    deleteServiceAction: vi.fn(),
    getBookingSettingsAction: vi.fn(),
  },
}));
vi.mock("@/features/services/actions/services", () => ({
  listServicesAction: (...args: unknown[]) =>
    actions.listServicesAction(...args),
  createServiceAction: (...args: unknown[]) =>
    actions.createServiceAction(...args),
  updateServiceAction: (...args: unknown[]) =>
    actions.updateServiceAction(...args),
  setServiceActiveAction: (...args: unknown[]) =>
    actions.setServiceActiveAction(...args),
  reorderServicesAction: (...args: unknown[]) =>
    actions.reorderServicesAction(...args),
  deleteServiceAction: (...args: unknown[]) =>
    actions.deleteServiceAction(...args),
}));
vi.mock("@/features/availability/actions/schedule", () => ({
  getBookingSettingsAction: (...args: unknown[]) =>
    actions.getBookingSettingsAction(...args),
}));

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, fieldErrors?: Record<string, string[]>) => ({
  ok: false as const,
  error: { code, message: "backend text never shown", fieldErrors },
});
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

let sequence = 0;
const service = (overrides: Partial<ServiceView> = {}): ServiceView => {
  sequence += 1;
  return {
    id: `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    name: "Rehaussement de cils",
    description: null,
    durationMinutes: 75,
    priceCents: 6500,
    active: true,
    displayOrder: sequence,
    version: 1,
    ...overrides,
  };
};
const settings = ok({
  currency: "EUR",
  slotIntervalMinutes: 15,
  bufferMinutes: 10,
  minimumBookingNoticeMinutes: 120,
  maximumBookingAdvanceDays: 90,
});

async function renderManager(services: ServiceView[]) {
  actions.listServicesAction.mockResolvedValue(ok(services));
  actions.getBookingSettingsAction.mockResolvedValue(settings);
  const view = render(<ServicesManager />);
  await flush();
  return view;
}

const dialog = () => within(screen.getByRole("dialog"));
const field = (name: RegExp) =>
  dialog().getByLabelText(name) as HTMLInputElement | HTMLTextAreaElement;
const type = (name: RegExp, value: string) =>
  fireEvent.change(field(name), { target: { value } });
const save = () =>
  fireEvent.click(dialog().getByRole("button", { name: /^Enregistrer/ }));
const list = () =>
  within(screen.getByRole("list", { name: "Tes prestations, dans l’ordre" }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  Object.values(actions).forEach((mock) => mock.mockReset());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("services list", () => {
  it("shows the services in their order, with duration, price in the business currency, and status", async () => {
    await renderManager([
      service({
        name: "Pose cil à cil",
        durationMinutes: 120,
        priceCents: 11000,
      }),
      service({
        name: "Retouche",
        durationMinutes: 45,
        priceCents: 4550,
        active: false,
      }),
    ]);
    const items = list().getAllByRole("listitem");
    expect(
      items.map((item) => within(item).getByRole("heading").textContent),
    ).toEqual(["Pose cil à cil", "RetoucheDésactivée"]);
    expect(within(items[0]!).getByText(/2 h · 110,00\s€/)).toBeTruthy();
    expect(within(items[1]!).getByText(/45 min · 45,50\s€/)).toBeTruthy();
    expect(
      (within(items[1]!).getByRole("switch") as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("a new business: explains what a service is and offers to add one", async () => {
    await renderManager([]);
    expect(screen.getByText("Ajoute ta première prestation")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /Ajouter une prestation/ }).length,
    ).toBeGreaterThan(0);
  });

  it("a failed read says so and retries", async () => {
    actions.listServicesAction.mockResolvedValueOnce(fail("network"));
    actions.getBookingSettingsAction.mockResolvedValue(settings);
    render(<ServicesManager />);
    await flush();
    expect(
      screen.getByText("Tes prestations n’ont pas pu être chargées."),
    ).toBeTruthy();
    actions.listServicesAction.mockResolvedValueOnce(ok([service()]));
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(list().getAllByRole("listitem")).toHaveLength(1);
  });
});

describe("creating a service", () => {
  it("sends name, minutes and exact cents; the list shows it once the backend confirmed it", async () => {
    await renderManager([]);
    fireEvent.click(
      screen.getAllByRole("button", { name: /Ajouter une prestation/ })[0]!,
    );
    await flush();
    type(/^Nom/, " Pose cil à cil ");
    type(/^Durée/, "120");
    type(/^Prix/, "110,50");
    const created = service({
      name: "Pose cil à cil",
      durationMinutes: 120,
      priceCents: 11050,
    });
    const pending = deferred();
    actions.createServiceAction.mockReturnValueOnce(pending.promise);
    save();
    save(); // double tap
    await flush();
    expect(actions.createServiceAction).toHaveBeenCalledTimes(1);
    expect(actions.createServiceAction.mock.calls[0]![0]).toEqual({
      name: "Pose cil à cil",
      description: null,
      durationMinutes: 120,
      priceCents: 11050,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    // Locked while it is sent: typing cannot slip in and be dropped.
    expect((field(/^Nom/) as HTMLInputElement).readOnly).toBe(true);
    type(/^Nom/, "Autre chose");
    expect(field(/^Nom/).value).toBe(" Pose cil à cil ");
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Not confirmed yet: not in the list.
    expect(screen.queryByRole("list", { name: /Tes prestations/ })).toBeNull();

    actions.listServicesAction.mockResolvedValue(ok([created]));
    pending.resolve(ok(created));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      list().getByRole("heading", { name: "Pose cil à cil" }),
    ).toBeTruthy();
    expect(screen.getByText("Pose cil à cil a été ajoutée.")).toBeTruthy();
  });

  it("explains invalid values before sending, and the backend's refusals by field", async () => {
    await renderManager([]);
    fireEvent.click(
      screen.getAllByRole("button", { name: /Ajouter une prestation/ })[0]!,
    );
    await flush();
    type(/^Durée/, "3");
    type(/^Prix/, "abc");
    save();
    await flush();
    expect(actions.createServiceAction).not.toHaveBeenCalled();
    expect(dialog().getByText("Donne un nom à la prestation.")).toBeTruthy();
    expect(document.activeElement).toBe(field(/^Nom/));

    type(/^Nom/, "Soin");
    type(/^Durée/, "60");
    type(/^Prix/, "40");
    actions.createServiceAction.mockResolvedValueOnce(
      fail("validation_error", { durationMinutes: ["x"] }),
    );
    save();
    await flush();
    expect(
      dialog().getByText("Durée entre 5 minutes et 12 heures."),
    ).toBeTruthy();
    expect(dialog().queryByText(/backend text/)).toBeNull();
  });

  it("a lost answer: the list is checked before anything is sent again, never creating it twice blindly", async () => {
    await renderManager([service({ name: "Existante" })]);
    fireEvent.click(
      screen.getByRole("button", { name: /Ajouter une prestation/ }),
    );
    await flush();
    type(/^Nom/, "Soin");
    type(/^Durée/, "60");
    type(/^Prix/, "40");
    // The answer is lost and the service is not there (yet).
    actions.createServiceAction.mockResolvedValueOnce(fail("network"));
    save();
    await flush();
    expect(
      dialog().getByText(/n’apparaît pas encore dans ta liste/),
    ).toBeTruthy();
    expect(field(/^Nom/).value).toBe("Soin");
    expect((field(/^Nom/) as HTMLInputElement).readOnly).toBe(false);

    // Meanwhile the first request was written: the retry finds it.
    const written = service({
      name: "Soin",
      durationMinutes: 60,
      priceCents: 4000,
    });
    actions.listServicesAction.mockResolvedValue(
      ok([service({ name: "Existante" }), written]),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(actions.createServiceAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Soin a été ajoutée.")).toBeTruthy();
  });

  it("a failed save keeps the exact draft and unlocks it; closing keeps it for later", async () => {
    await renderManager([]);
    fireEvent.click(
      screen.getAllByRole("button", { name: /Ajouter une prestation/ })[0]!,
    );
    await flush();
    type(/^Nom/, "Soin");
    type(/^Prix/, "40");
    actions.createServiceAction.mockResolvedValueOnce(fail("internal"));
    save();
    await flush();
    expect(dialog().getByText("Enregistrement impossible")).toBeTruthy();
    expect(field(/^Nom/).value).toBe("Soin");
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder pour plus tard" }),
    );
    await flush();
    fireEvent.click(
      screen.getAllByRole("button", { name: /Ajouter une prestation/ })[0]!,
    );
    await flush();
    expect(field(/^Nom/).value).toBe("Soin");
  });
});

describe("editing and deactivating", () => {
  it("edits only the changed fields; the booked appointments keep theirs (said in the form)", async () => {
    const existing = service({ name: "Rehaussement", priceCents: 6500 });
    await renderManager([existing]);
    fireEvent.click(
      list().getByRole("button", { name: "Modifier Rehaussement" }),
    );
    await flush();
    expect(
      dialog().getByText(
        /Les rendez-vous déjà pris gardent le nom, la durée et le prix/,
      ),
    ).toBeTruthy();
    type(/^Prix/, "70");
    const updated = { ...existing, priceCents: 7000 };
    actions.updateServiceAction.mockResolvedValueOnce(ok(updated));
    actions.listServicesAction.mockResolvedValue(ok([updated]));
    save();
    await flush();
    expect(actions.updateServiceAction).toHaveBeenCalledWith({
      serviceId: existing.id,
      expectedVersion: existing.version,
      changes: { priceCents: 7000 },
    });
    expect(list().getByText(/70,00\s€/)).toBeTruthy();
  });

  it("deactivating waits for the backend; a refusal keeps the real state and says so", async () => {
    const existing = service({ name: "Retouche" });
    await renderManager([existing]);
    const toggle = list().getByRole("switch", { name: "Proposer Retouche" });
    const pending = deferred();
    actions.setServiceActiveAction.mockReturnValueOnce(pending.promise);
    fireEvent.click(toggle);
    await flush();
    expect(actions.setServiceActiveAction).toHaveBeenCalledWith({
      serviceId: existing.id,
      active: false,
    });
    // Not confirmed: still shown as offered, and locked.
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    pending.resolve(ok({ ...existing, active: false }));
    await flush();
    expect((list().getByRole("switch") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(list().getAllByText("Désactivée").length).toBeGreaterThan(0);

    actions.setServiceActiveAction.mockResolvedValueOnce(fail("internal"));
    fireEvent.click(list().getByRole("switch"));
    await flush();
    expect((list().getByRole("switch") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(list().getByRole("alert").textContent).toMatch(
      /n’a pas pu être enregistré/,
    );
  });

  it("reorders with the complete list; a list changed elsewhere is read again", async () => {
    const first = service({ name: "Un" });
    const second = service({ name: "Deux" });
    await renderManager([first, second]);
    actions.reorderServicesAction.mockResolvedValueOnce(ok([second, first]));
    fireEvent.click(list().getByRole("button", { name: "Descendre Un" }));
    await flush();
    expect(actions.reorderServicesAction).toHaveBeenCalledWith({
      serviceIds: [second.id, first.id],
    });
    expect(
      list()
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Deux", "Un"]);

    actions.reorderServicesAction.mockResolvedValueOnce(
      fail("validation_error"),
    );
    fireEvent.click(list().getByRole("button", { name: "Monter Un" }));
    await flush();
    expect(screen.getByText(/Ta liste a changé entre-temps/)).toBeTruthy();
    expect(actions.listServicesAction).toHaveBeenCalledTimes(2);
  });

  it("a booked service cannot be deleted: its history is kept, deactivating is offered", async () => {
    const booked = service({ name: "Pose" });
    await renderManager([booked]);
    fireEvent.click(list().getByRole("button", { name: "Supprimer Pose" }));
    await flush();
    actions.deleteServiceAction.mockResolvedValueOnce(fail("in_use"));
    fireEvent.click(dialog().getByRole("button", { name: "Supprimer" }));
    await flush();
    expect(dialog().getByText("Elle a déjà des rendez-vous")).toBeTruthy();
    expect(list().getByRole("heading", { name: "Pose" })).toBeTruthy();
    actions.setServiceActiveAction.mockResolvedValueOnce(
      ok({ ...booked, active: false }),
    );
    fireEvent.click(
      dialog().getByRole("button", { name: "La désactiver plutôt" }),
    );
    await flush();
    expect(actions.setServiceActiveAction).toHaveBeenCalledWith({
      serviceId: booked.id,
      active: false,
    });
  });

  it("an unbooked service is deleted after confirmation", async () => {
    const unused = service({ name: "Essai" });
    await renderManager([unused, service({ name: "Autre" })]);
    fireEvent.click(list().getByRole("button", { name: "Supprimer Essai" }));
    await flush();
    actions.deleteServiceAction.mockResolvedValueOnce(ok(undefined));
    fireEvent.click(dialog().getByRole("button", { name: "Supprimer" }));
    await flush();
    expect(actions.deleteServiceAction).toHaveBeenCalledWith({
      serviceId: unused.id,
    });
    expect(list().queryByRole("heading", { name: "Essai" })).toBeNull();
  });
});

// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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

// Two identities (signed-in user and business), as the page passes them.
const A = { userId: "user-a", businessId: "business-a" };
const B = { userId: "user-b", businessId: "business-b" };

async function renderManager(services: ServiceView[], scope = A) {
  actions.listServicesAction.mockResolvedValue(ok(services));
  actions.getBookingSettingsAction.mockResolvedValue(settings);
  const view = render(<ServicesManager scope={scope} />);
  await flush();
  return view;
}

const openCreate = () =>
  fireEvent.click(
    screen.getAllByRole("button", { name: /Ajouter une prestation/ })[0]!,
  );
const fillSoin = () => {
  type(/^Nom/, "Soin");
  type(/^Durée/, "60");
  type(/^Prix/, "40");
};
const requestIds = () =>
  actions.createServiceAction.mock.calls.map(
    ([command]) => (command as { requestId: string }).requestId,
  );

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
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  // jsdom has no scrollIntoView; some tests add one.
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
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
    render(<ServicesManager scope={A} />);
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

  it("A. a lost answer: the same values are resent with the same request id, and the service is listed once", async () => {
    await renderManager([service({ name: "Existante" })]);
    openCreate();
    await flush();
    fillSoin();
    actions.createServiceAction.mockResolvedValueOnce(fail("network"));
    save();
    await flush();
    expect(dialog().getByText("Création non confirmée")).toBeTruthy();
    expect(field(/^Nom/).value).toBe("Soin");
    expect((field(/^Nom/) as HTMLInputElement).readOnly).toBe(false);

    // The first request had been written: the backend answers that service.
    const written = service({
      name: "Soin",
      durationMinutes: 60,
      priceCents: 4000,
    });
    actions.createServiceAction.mockResolvedValueOnce(ok(written));
    actions.listServicesAction.mockResolvedValue(
      ok([service({ name: "Existante" }), written]),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(actions.createServiceAction).toHaveBeenCalledTimes(2);
    expect(requestIds()).toEqual([requestIds()[0], requestIds()[0]]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Soin a été ajoutée.")).toBeTruthy();
    expect(list().getAllByRole("heading", { name: "Soin" })).toHaveLength(1);
    // Nothing left to resume.
    expect(screen.queryByText("Une création n’a pas été confirmée")).toBeNull();
    openCreate();
    await flush();
    expect(field(/^Nom/).value).toBe("");
  });

  it("B. closed after a lost answer: the list says so, and resuming resends with the same request id", async () => {
    await renderManager([]);
    openCreate();
    await flush();
    fillSoin();
    actions.createServiceAction.mockResolvedValueOnce(fail("network"));
    save();
    await flush();
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder pour plus tard" }),
    );
    await flush();
    expect(screen.getByText("Une création n’a pas été confirmée")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Reprendre la création" }),
    );
    await flush();
    expect(field(/^Nom/).value).toBe("Soin");
    expect(
      dialog().getByText(/si la prestation avait déjà été créée/),
    ).toBeTruthy();
    actions.createServiceAction.mockResolvedValueOnce(fail("network"));
    save();
    await flush();
    expect(requestIds()[1]).toBe(requestIds()[0]);
  });

  it("B. …even after leaving the page and coming back", async () => {
    const view = await renderManager([]);
    openCreate();
    await flush();
    fillSoin();
    actions.createServiceAction.mockResolvedValueOnce(fail("internal"));
    save();
    await flush();
    view.unmount();

    await renderManager([]);
    expect(screen.getByText("Une création n’a pas été confirmée")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Reprendre la création" }),
    );
    await flush();
    const created = service({ name: "Soin" });
    actions.createServiceAction.mockResolvedValueOnce(ok(created));
    save();
    await flush();
    expect(requestIds()[1]).toBe(requestIds()[0]);
    expect(screen.queryByText("Une création n’a pas été confirmée")).toBeNull();
  });

  it("C. a second service with the same details, on purpose, is a new request", async () => {
    await renderManager([]);
    openCreate();
    await flush();
    fillSoin();
    actions.createServiceAction.mockResolvedValueOnce(
      ok(service({ name: "Soin" })),
    );
    save();
    await flush();
    openCreate();
    await flush();
    expect(field(/^Nom/).value).toBe("");
    fillSoin();
    actions.createServiceAction.mockResolvedValueOnce(
      ok(service({ name: "Soin" })),
    );
    save();
    await flush();
    expect(requestIds()[1]).not.toBe(requestIds()[0]);
  });

  it("C. values changed after a lost answer: said, and sent as a new request", async () => {
    await renderManager([]);
    openCreate();
    await flush();
    fillSoin();
    actions.createServiceAction.mockResolvedValueOnce(fail("network"));
    save();
    await flush();
    type(/^Prix/, "45");
    expect(
      dialog().getByText(/l’enregistrer en créera une nouvelle/),
    ).toBeTruthy();
    actions.createServiceAction.mockResolvedValueOnce(fail("network"));
    save();
    await flush();
    expect(requestIds()[1]).not.toBe(requestIds()[0]);
  });

  it("D. a request id already used for other values: nothing is resent until the professional chooses", async () => {
    await renderManager([]);
    openCreate();
    await flush();
    fillSoin();
    actions.createServiceAction.mockResolvedValueOnce(
      fail("idempotency_conflict"),
    );
    save();
    await flush();
    expect(dialog().getByText("Rien n’a été créé")).toBeTruthy();
    expect(actions.createServiceAction).toHaveBeenCalledTimes(1);
    expect(field(/^Nom/).value).toBe("Soin");

    actions.createServiceAction.mockResolvedValueOnce(
      ok(service({ name: "Soin" })),
    );
    fireEvent.click(
      dialog().getByRole("button", {
        name: "La créer comme nouvelle prestation",
      }),
    );
    await flush();
    expect(actions.createServiceAction).toHaveBeenCalledTimes(2);
    expect(requestIds()[1]).not.toBe(requestIds()[0]);
    expect(screen.getByText("Soin a été ajoutée.")).toBeTruthy();
  });

  it("E. created then deleted meanwhile: never recreated implicitly, the list is read again", async () => {
    await renderManager([]);
    openCreate();
    await flush();
    fillSoin();
    actions.createServiceAction.mockResolvedValueOnce(fail("network"));
    save();
    await flush();
    actions.createServiceAction.mockResolvedValueOnce(fail("service_deleted"));
    fireEvent.click(dialog().getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(dialog().getByText("Prestation supprimée depuis")).toBeTruthy();
    expect(actions.listServicesAction).toHaveBeenCalledTimes(2);
    expect(requestIds()[1]).toBe(requestIds()[0]);

    // Saving again is the same command: refused again, not recreated.
    actions.createServiceAction.mockResolvedValueOnce(fail("service_deleted"));
    save();
    await flush();
    expect(requestIds()[2]).toBe(requestIds()[0]);
    fireEvent.click(dialog().getByRole("button", { name: "Abandonner" }));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Une création n’a pas été confirmée")).toBeNull();
    openCreate();
    await flush();
    expect(field(/^Nom/).value).toBe("");
  });

  it("M. a refused save keeps the exact draft and unlocks it; closing keeps it for later", async () => {
    await renderManager([]);
    openCreate();
    await flush();
    type(/^Nom/, "Soin");
    type(/^Prix/, "40");
    actions.createServiceAction.mockResolvedValueOnce(fail("unauthenticated"));
    save();
    await flush();
    expect(dialog().getByText("Session expirée")).toBeTruthy();
    expect(field(/^Nom/).value).toBe("Soin");
    expect(field(/^Prix/).value).toBe("40");
    expect((field(/^Nom/) as HTMLInputElement).readOnly).toBe(false);
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder pour plus tard" }),
    );
    await flush();
    openCreate();
    await flush();
    expect(field(/^Nom/).value).toBe("Soin");
    expect(field(/^Prix/).value).toBe("40");
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

  it("F. changed elsewhere: nothing is saved, the current version is shown field by field, the draft is kept", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const existing = service({ name: "Rehaussement", priceCents: 6500 });
    await renderManager([existing]);
    fireEvent.click(
      list().getByRole("button", { name: "Modifier Rehaussement" }),
    );
    await flush();
    type(/^Prix/, "70");
    actions.updateServiceAction.mockResolvedValueOnce(fail("stale_service"));
    actions.listServicesAction.mockResolvedValue(
      ok([{ ...existing, name: "Rehaussement XL", version: 2 }]),
    );
    save();
    await flush();
    expect(
      dialog().getByText("Version actuelle de la prestation"),
    ).toBeTruthy();
    expect(dialog().getByText("Maintenant : Rehaussement XL")).toBeTruthy();
    // Brought into view: below the fields, above the sticky bar.
    expect(scrolled).toHaveBeenCalled();
    expect(dialog().getByText(/Tu ne l’avais pas modifié/)).toBeTruthy();
    expect(field(/^Prix/).value).toBe("70");
    expect(field(/^Nom/).value).toBe("Rehaussement");
    expect(
      (
        dialog().getByRole("button", {
          name: /^Enregistrer/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(actions.updateServiceAction).toHaveBeenCalledTimes(1);
  });

  it("G. different fields: keeping mine takes the other change, and sends only mine on the new version", async () => {
    const existing = service({ name: "Rehaussement", priceCents: 6500 });
    await renderManager([existing]);
    fireEvent.click(
      list().getByRole("button", { name: "Modifier Rehaussement" }),
    );
    await flush();
    type(/^Prix/, "70");
    const latest = { ...existing, name: "Rehaussement XL", version: 2 };
    actions.updateServiceAction.mockResolvedValueOnce(fail("stale_service"));
    actions.listServicesAction.mockResolvedValue(ok([latest]));
    save();
    await flush();
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder mes modifications" }),
    );
    expect(field(/^Nom/).value).toBe("Rehaussement XL");
    expect(field(/^Prix/).value).toBe("70");

    actions.updateServiceAction.mockResolvedValueOnce(
      ok({ ...latest, priceCents: 7000, version: 3 }),
    );
    save();
    await flush();
    expect(actions.updateServiceAction).toHaveBeenLastCalledWith({
      serviceId: existing.id,
      expectedVersion: 2,
      changes: { priceCents: 7000 },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("H. the same field: both values are shown; mine is sent only on purpose, or theirs is taken", async () => {
    const existing = service({ name: "Rehaussement", priceCents: 6500 });
    await renderManager([existing]);
    fireEvent.click(
      list().getByRole("button", { name: "Modifier Rehaussement" }),
    );
    await flush();
    type(/^Prix/, "70");
    const latest = { ...existing, priceCents: 8000, version: 2 };
    actions.updateServiceAction.mockResolvedValueOnce(fail("stale_service"));
    actions.listServicesAction.mockResolvedValue(ok([latest]));
    save();
    await flush();
    expect(dialog().getByText(/^Maintenant : 80/)).toBeTruthy();
    expect(dialog().getByText("Ta saisie : 70")).toBeTruthy();

    fireEvent.click(
      dialog().getByRole("button", { name: "Reprendre la version actuelle" }),
    );
    expect(field(/^Prix/).value).toMatch(/^80/);
    expect(actions.updateServiceAction).toHaveBeenCalledTimes(1);

    // Typed again, and refused again: this time, mine on purpose.
    type(/^Prix/, "70");
    actions.updateServiceAction.mockResolvedValueOnce(fail("stale_service"));
    const later = { ...latest, priceCents: 9000, version: 3 };
    actions.listServicesAction.mockResolvedValue(ok([later]));
    save();
    await flush();
    expect(actions.updateServiceAction).toHaveBeenLastCalledWith({
      serviceId: existing.id,
      expectedVersion: 2,
      changes: { priceCents: 7000 },
    });
    fireEvent.click(dialog().getByRole("button", { name: "Garder ma saisie" }));
    actions.updateServiceAction.mockResolvedValueOnce(
      ok({ ...later, priceCents: 7000, version: 4 }),
    );
    save();
    await flush();
    expect(actions.updateServiceAction).toHaveBeenLastCalledWith({
      serviceId: existing.id,
      expectedVersion: 3,
      changes: { priceCents: 7000 },
    });
  });

  it("H. a kept draft reopened after the service changed is compared before anything is sent", async () => {
    const existing = service({ name: "Rehaussement", priceCents: 6500 });
    await renderManager([existing]);
    fireEvent.click(
      list().getByRole("button", { name: "Modifier Rehaussement" }),
    );
    await flush();
    type(/^Prix/, "70");
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder pour plus tard" }),
    );
    await flush();
    // Deactivated elsewhere, then seen in a fresher list.
    actions.setServiceActiveAction.mockResolvedValueOnce(
      ok({ ...existing, name: "Rehaussement 2", version: 2 }),
    );
    fireEvent.click(
      list().getByRole("switch", { name: "Proposer Rehaussement" }),
    );
    await flush();
    fireEvent.click(
      list().getByRole("button", { name: "Modifier Rehaussement 2" }),
    );
    await flush();
    expect(
      dialog().getByText("Version actuelle de la prestation"),
    ).toBeTruthy();
    expect(field(/^Prix/).value).toBe("70");
    expect(actions.updateServiceAction).not.toHaveBeenCalled();
  });

  it("I. activation is by value, without a version; the answer replaces the row (and its version)", async () => {
    const existing = service({ name: "Retouche", version: 4 });
    await renderManager([existing]);
    actions.setServiceActiveAction.mockResolvedValueOnce(
      ok({ ...existing, active: false, version: 5 }),
    );
    fireEvent.click(list().getByRole("switch", { name: "Proposer Retouche" }));
    await flush();
    expect(actions.setServiceActiveAction).toHaveBeenCalledWith({
      serviceId: existing.id,
      active: false,
    });
    fireEvent.click(list().getByRole("button", { name: "Modifier Retouche" }));
    await flush();
    type(/^Prix/, "70");
    actions.updateServiceAction.mockResolvedValueOnce(
      ok({ ...existing, active: false, priceCents: 7000, version: 6 }),
    );
    save();
    await flush();
    expect(actions.updateServiceAction).toHaveBeenCalledWith({
      serviceId: existing.id,
      expectedVersion: 5,
      changes: { priceCents: 7000 },
    });
  });

  it("M. a failed edit keeps the exact draft, unlocked, and the retry sends it again on the same version", async () => {
    const existing = service({ name: "Rehaussement" });
    await renderManager([existing]);
    fireEvent.click(
      list().getByRole("button", { name: "Modifier Rehaussement" }),
    );
    await flush();
    type(/^Nom/, "Rehaussement teinté");
    type(/^Prix/, "72,50");
    actions.updateServiceAction.mockResolvedValueOnce(fail("internal"));
    save();
    await flush();
    expect(dialog().getByText("Enregistrement impossible")).toBeTruthy();
    expect(field(/^Nom/).value).toBe("Rehaussement teinté");
    expect(field(/^Prix/).value).toBe("72,50");
    expect((field(/^Prix/) as HTMLInputElement).readOnly).toBe(false);
    actions.updateServiceAction.mockResolvedValueOnce(
      ok({
        ...existing,
        name: "Rehaussement teinté",
        priceCents: 7250,
        version: 2,
      }),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(actions.updateServiceAction.mock.calls[1]![0]).toEqual(
      actions.updateServiceAction.mock.calls[0]![0],
    );
    expect(screen.queryByRole("dialog")).toBeNull();
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

describe("deletion refused, then acknowledged", () => {
  it("H. in_use, then « Compris »: every action of every row works again", async () => {
    const booked = service({ name: "Pose" });
    const other = service({ name: "Autre" });
    await renderManager([booked, other]);
    fireEvent.click(list().getByRole("button", { name: "Supprimer Pose" }));
    await flush();
    actions.deleteServiceAction.mockResolvedValueOnce(fail("in_use"));
    fireEvent.click(dialog().getByRole("button", { name: "Supprimer" }));
    await flush();
    fireEvent.click(dialog().getByRole("button", { name: "Compris" }));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(list().getByRole("heading", { name: "Pose" })).toBeTruthy();

    for (const name of ["Pose", "Autre"]) {
      for (const control of [
        list().getByRole("button", { name: `Modifier ${name}` }),
        list().getByRole("button", { name: `Supprimer ${name}` }),
        list().getByRole("switch", { name: `Proposer ${name}` }),
      ]) {
        expect((control as HTMLButtonElement).disabled).toBe(false);
      }
    }
    actions.setServiceActiveAction.mockResolvedValueOnce(
      ok({ ...booked, active: false, version: 2 }),
    );
    fireEvent.click(list().getByRole("switch", { name: "Proposer Pose" }));
    await flush();
    expect(actions.setServiceActiveAction).toHaveBeenCalledWith({
      serviceId: booked.id,
      active: false,
    });
    fireEvent.click(list().getByRole("button", { name: "Modifier Autre" }));
    await flush();
    expect(
      screen.getByRole("dialog", { name: "Modifier la prestation" }),
    ).toBeTruthy();
  });

  it("H. …dismissed with Escape instead: nothing stays locked either", async () => {
    const booked = service({ name: "Pose" });
    await renderManager([booked]);
    fireEvent.click(list().getByRole("button", { name: "Supprimer Pose" }));
    await flush();
    actions.deleteServiceAction.mockResolvedValueOnce(fail("in_use"));
    fireEvent.click(dialog().getByRole("button", { name: "Supprimer" }));
    await flush();
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      (
        list().getByRole("button", {
          name: "Modifier Pose",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("a refused activation is said on its row, and locks nothing (retry included)", async () => {
    const first = service({ name: "Un" });
    await renderManager([first, service({ name: "Deux" })]);
    actions.setServiceActiveAction.mockResolvedValueOnce(fail("internal"));
    fireEvent.click(list().getByRole("switch", { name: "Proposer Un" }));
    await flush();
    expect(list().getByRole("alert").textContent).toMatch(
      /n’a pas pu être enregistré/,
    );
    expect(
      (
        list().getByRole("button", {
          name: "Modifier Deux",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    actions.setServiceActiveAction.mockResolvedValueOnce(
      ok({ ...first, active: false, version: 2 }),
    );
    fireEvent.click(list().getByRole("switch", { name: "Proposer Un" }));
    await flush();
    expect(actions.setServiceActiveAction).toHaveBeenCalledTimes(2);
    expect(list().queryByRole("alert")).toBeNull();
  });
});

describe("an edit kept for later", () => {
  const openEdit = (name: string) =>
    fireEvent.click(list().getByRole("button", { name: `Modifier ${name}` }));
  const keepForLater = () =>
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder pour plus tard" }),
    );

  it("I. survives leaving the page: restored on return, and saved from there", async () => {
    const existing = service({ name: "Rehaussement", priceCents: 6500 });
    const view = await renderManager([existing]);
    openEdit("Rehaussement");
    await flush();
    type(/^Prix/, "70");
    keepForLater();
    await flush();
    view.unmount(); // another page of the app

    await renderManager([existing]);
    openEdit("Rehaussement");
    await flush();
    expect(field(/^Prix/).value).toBe("70");
    expect(dialog().queryByText(/Version actuelle/)).toBeNull();
    actions.updateServiceAction.mockResolvedValueOnce(
      ok({ ...existing, priceCents: 7000, version: 2 }),
    );
    save();
    await flush();
    expect(actions.updateServiceAction).toHaveBeenCalledWith({
      serviceId: existing.id,
      expectedVersion: 1,
      changes: { priceCents: 7000 },
    });
  });

  it("J. restored on a service changed since: compared, nothing sent, the draft kept", async () => {
    const existing = service({ name: "Rehaussement", priceCents: 6500 });
    const view = await renderManager([existing]);
    openEdit("Rehaussement");
    await flush();
    type(/^Prix/, "70");
    keepForLater();
    await flush();
    view.unmount();

    const changed = { ...existing, name: "Rehaussement XL", version: 2 };
    await renderManager([changed]);
    openEdit("Rehaussement XL");
    await flush();
    expect(
      dialog().getByText("Version actuelle de la prestation"),
    ).toBeTruthy();
    expect(dialog().getByText("Maintenant : Rehaussement XL")).toBeTruthy();
    expect(field(/^Prix/).value).toBe("70");
    expect(
      (
        dialog().getByRole("button", {
          name: /^Enregistrer/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder mes modifications" }),
    );
    actions.updateServiceAction.mockResolvedValueOnce(
      ok({ ...changed, priceCents: 7000, version: 3 }),
    );
    save();
    await flush();
    expect(actions.updateServiceAction).toHaveBeenCalledWith({
      serviceId: existing.id,
      expectedVersion: 2,
      changes: { priceCents: 7000 },
    });
  });

  it("K. a confirmed save clears only that service's draft", async () => {
    const one = service({ name: "Un", priceCents: 1000 });
    const two = service({ name: "Deux", priceCents: 2000 });
    const view = await renderManager([one, two]);
    openEdit("Un");
    await flush();
    type(/^Prix/, "11");
    keepForLater();
    await flush();
    openEdit("Deux");
    await flush();
    type(/^Prix/, "22");
    actions.updateServiceAction.mockResolvedValueOnce(
      ok({ ...two, priceCents: 2200, version: 2 }),
    );
    save();
    await flush();
    view.unmount();

    await renderManager([one, { ...two, priceCents: 2200, version: 2 }]);
    openEdit("Un");
    await flush();
    expect(field(/^Prix/).value).toBe("11");
    keepForLater();
    await flush();
    openEdit("Deux");
    await flush();
    expect(field(/^Prix/).value).toMatch(/^22/);
    expect(dialog().queryByRole("button", { name: /Abandonner/ })).toBeNull();
  });

  it("L. a failed save keeps the draft, even after leaving the page", async () => {
    const existing = service({ name: "Rehaussement" });
    const view = await renderManager([existing]);
    openEdit("Rehaussement");
    await flush();
    type(/^Nom/, "Rehaussement teinté");
    actions.updateServiceAction.mockResolvedValueOnce(fail("network"));
    save();
    await flush();
    expect(field(/^Nom/).value).toBe("Rehaussement teinté");
    view.unmount();

    await renderManager([existing]);
    openEdit("Rehaussement");
    await flush();
    expect(field(/^Nom/).value).toBe("Rehaussement teinté");
  });

  it("discarding it on purpose removes it", async () => {
    const existing = service({ name: "Rehaussement" });
    const view = await renderManager([existing]);
    openEdit("Rehaussement");
    await flush();
    type(/^Nom/, "Autre nom");
    fireEvent.click(
      dialog().getByRole("button", { name: "Abandonner mes modifications" }),
    );
    await flush();
    view.unmount();
    await renderManager([existing]);
    openEdit("Rehaussement");
    await flush();
    expect(field(/^Nom/).value).toBe("Rehaussement");
  });
});

// The page is rendered again for another identity (sign-in as someone else,
// another business) WITHOUT unmounting: same component instance, new props,
// as a Server Component refresh does. Nothing of A may reach B.
describe("another identity on the same mounted page", () => {
  it("A. F. an open creation of A is never shown or sent under B", async () => {
    const view = await renderManager([service({ name: "Chez A" })], A);
    openCreate();
    await flush();
    fillSoin();

    actions.listServicesAction.mockResolvedValue(
      ok([service({ name: "Chez B" })]),
    );
    view.rerender(<ServicesManager scope={B} />);
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(list().getByRole("heading", { name: "Chez B" })).toBeTruthy();
    expect(list().queryByRole("heading", { name: "Chez A" })).toBeNull();

    openCreate();
    await flush();
    expect(field(/^Nom/).value).toBe("");
    type(/^Nom/, "Soin B");
    type(/^Prix/, "30");
    actions.createServiceAction.mockResolvedValueOnce(
      ok(service({ name: "Soin B" })),
    );
    save();
    await flush();
    expect(actions.createServiceAction).toHaveBeenCalledTimes(1);
    expect(actions.createServiceAction.mock.calls[0]![0]).toMatchObject({
      name: "Soin B",
      priceCents: 3000,
    });
  });

  it("A. F. an open edit of A is never sent under B, even for a service id B also lists", async () => {
    const shared = service({ name: "Pose", priceCents: 5000 });
    const view = await renderManager([shared], A);
    fireEvent.click(list().getByRole("button", { name: "Modifier Pose" }));
    await flush();
    type(/^Prix/, "99");

    actions.listServicesAction.mockResolvedValue(ok([shared]));
    view.rerender(<ServicesManager scope={B} />);
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(list().getByRole("button", { name: "Modifier Pose" }));
    await flush();
    expect(field(/^Prix/).value).toBe("50");
    expect(actions.updateServiceAction).not.toHaveBeenCalled();
  });

  it("G. A's unconfirmed creation and kept edits never appear under B", async () => {
    const shared = service({ name: "Pose", priceCents: 5000 });
    const view = await renderManager([shared], A);
    fireEvent.click(list().getByRole("button", { name: "Modifier Pose" }));
    await flush();
    type(/^Prix/, "99");
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder pour plus tard" }),
    );
    await flush();
    openCreate();
    await flush();
    fillSoin();
    actions.createServiceAction.mockResolvedValueOnce(fail("network"));
    save();
    await flush();
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder pour plus tard" }),
    );
    await flush();
    expect(screen.getByText("Une création n’a pas été confirmée")).toBeTruthy();

    view.rerender(<ServicesManager scope={B} />);
    await flush();
    expect(screen.queryByText("Une création n’a pas été confirmée")).toBeNull();
    openCreate();
    await flush();
    expect(field(/^Nom/).value).toBe("");
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    fireEvent.click(list().getByRole("button", { name: "Modifier Pose" }));
    await flush();
    expect(field(/^Prix/).value).toBe("50");

    // Still A's, untouched: offered back to A.
    cleanup();
    await renderManager([shared], A);
    expect(screen.getByText("Une création n’a pas été confirmée")).toBeTruthy();
    fireEvent.click(list().getByRole("button", { name: "Modifier Pose" }));
    await flush();
    expect(field(/^Prix/).value).toBe("99");
  });

  it("D. A's list answering after the switch never replaces B's", async () => {
    const pendingA = deferred();
    actions.listServicesAction.mockReturnValueOnce(pendingA.promise);
    actions.getBookingSettingsAction.mockResolvedValue(settings);
    const view = render(<ServicesManager scope={A} />);
    await flush();

    actions.listServicesAction.mockResolvedValue(
      ok([service({ name: "Chez B" })]),
    );
    view.rerender(<ServicesManager scope={B} />);
    await flush();
    pendingA.resolve(ok([service({ name: "Chez A" })]));
    await flush();
    expect(list().getByRole("heading", { name: "Chez B" })).toBeTruthy();
    expect(list().queryByRole("heading", { name: "Chez A" })).toBeNull();
  });

  it("E. A's creation answering after the switch: nothing under B, and A's resend keeps its request id", async () => {
    const view = await renderManager([], A);
    openCreate();
    await flush();
    fillSoin();
    const pendingCreate = deferred();
    actions.createServiceAction.mockReturnValueOnce(pendingCreate.promise);
    save();
    await flush();

    actions.listServicesAction.mockResolvedValue(
      ok([service({ name: "Chez B" })]),
    );
    view.rerender(<ServicesManager scope={B} />);
    await flush();
    pendingCreate.resolve(ok(service({ name: "Soin" })));
    await flush();
    expect(screen.queryByText("Soin a été ajoutée.")).toBeNull();
    expect(list().queryByRole("heading", { name: "Soin" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      (
        list().getByRole("button", {
          name: "Modifier Chez B",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    // Back to A: its command was not reinterpreted. Resending the same
    // values carries the same request id (never a second service).
    cleanup();
    await renderManager([service({ name: "Soin" })], A);
    expect(screen.getByText("Une création n’a pas été confirmée")).toBeTruthy();
    openCreate();
    await flush();
    expect(field(/^Nom/).value).toBe("Soin");
    actions.createServiceAction.mockResolvedValueOnce(
      ok(service({ name: "Soin" })),
    );
    save();
    await flush();
    expect(requestIds()[1]).toBe(requestIds()[0]);
  });
});

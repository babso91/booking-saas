// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agenda,
  appointment,
  block,
  CLIENT_A,
  SERVICE_A,
  SERVICE_B,
  services,
  TZ,
} from "../../../../tests/support/agenda-fixtures";
import { AgendaView } from "./agenda-view";

const actions = {
  getAgendaAction: vi.fn(),
  getAgendaAppointmentAction: vi.fn(),
  listAgendaServicesAction: vi.fn(),
  searchAgendaClientsAction: vi.fn(),
  createAppointmentAction: vi.fn(),
  updateAppointmentAction: vi.fn(),
  setAppointmentStatusAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
  createBlockAction: vi.fn(),
  updateBlockAction: vi.fn(),
  deleteBlockAction: vi.fn(),
};

vi.mock("@/features/agenda/actions/agenda", () =>
  Object.fromEntries(
    Object.keys({
      getAgendaAction: 0,
      getAgendaAppointmentAction: 0,
      listAgendaServicesAction: 0,
      searchAgendaClientsAction: 0,
      createAppointmentAction: 0,
      updateAppointmentAction: 0,
      setAppointmentStatusAction: 0,
      cancelAppointmentAction: 0,
      createBlockAction: 0,
      updateBlockAction: 0,
      deleteBlockAction: 0,
    }).map((name) => [
      name,
      (...args: unknown[]) => actions[name as keyof typeof actions](...args),
    ]),
  ),
);

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, fieldErrors?: Record<string, string[]>) => ({
  ok: false as const,
  error: {
    code,
    message: "backend text never shown",
    ...(fieldErrors ? { fieldErrors } : {}),
  },
});

const TODAY = "2026-09-29"; // Tuesday
const originalMatchMedia = window.matchMedia;

function useViewport(wide: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches:
        query.includes("reduced-motion") ||
        (wide && query.includes("min-width: 768px")),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
}

function renderAgenda() {
  return render(<AgendaView timezone={TZ} today={TODAY} slug="studio-mila" />);
}

const lastCall = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls[mock.mock.calls.length - 1]![0];
const buttons = (name: RegExp | string) =>
  screen.getAllByRole("button", { name });
const panel = () => screen.getByRole("dialog");

async function openAppointment(
  user: ReturnType<typeof userEvent.setup>,
  label: RegExp,
) {
  await user.click(await screen.findByRole("button", { name: label }));
  return panel();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T08:00:00Z")); // 10:00 in Paris
  Object.values(actions).forEach((mock) => mock.mockReset());
  actions.listAgendaServicesAction.mockResolvedValue(ok(services));
  useViewport(false);
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
});

describe("loading", () => {
  it("desktop: loads exactly one week, in a single aggregated request", async () => {
    useViewport(true);
    actions.getAgendaAction.mockResolvedValue(
      ok(agenda("2026-09-28", "2026-10-04")),
    );
    renderAgenda();

    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenCalledWith({
        startDate: "2026-09-28",
        endDate: "2026-10-04",
        includeCancelled: false,
      }),
    );
    expect(actions.getAgendaAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "28 sept. – 4 oct. 2026",
    );
    expect(
      screen
        .getAllByRole("group", { name: /2026$/ })
        .filter((el) =>
          el.getAttribute("aria-label")?.match(/^\w+ \d+ \w+ 2026$/),
        ),
    ).toHaveLength(7);
  });

  it("phone: loads a single day", async () => {
    actions.getAgendaAction.mockResolvedValue(ok(agenda(TODAY, TODAY)));
    renderAgenda();

    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenCalledWith({
        startDate: TODAY,
        endDate: TODAY,
        includeCancelled: false,
      }),
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Mardi 29 septembre",
    );
  });

  it("navigates by day and back to today", async () => {
    const user = userEvent.setup();
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate)),
    );
    renderAgenda();
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenCalledTimes(1),
    );

    await user.click(screen.getByRole("button", { name: "Jour suivant" }));
    await waitFor(() =>
      expect(lastCall(actions.getAgendaAction)).toMatchObject({
        startDate: "2026-09-30",
        endDate: "2026-09-30",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Aujourd’hui" }));
    await waitFor(() =>
      expect(lastCall(actions.getAgendaAction)).toMatchObject({
        startDate: TODAY,
      }),
    );

    await user.click(
      screen.getByRole("button", { name: "dimanche 4 octobre 2026" }),
    );
    await waitFor(() =>
      expect(lastCall(actions.getAgendaAction)).toMatchObject({
        startDate: "2026-10-04",
      }),
    );
  });

  it("navigates by week on desktop", async () => {
    useViewport(true);
    const user = userEvent.setup();
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate)),
    );
    renderAgenda();
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenCalledTimes(1),
    );

    await user.click(screen.getByRole("button", { name: "Semaine suivante" }));
    await waitFor(() =>
      expect(lastCall(actions.getAgendaAction)).toMatchObject({
        startDate: "2026-10-05",
        endDate: "2026-10-11",
      }),
    );
  });

  it("shows a real empty state with the public link", async () => {
    actions.getAgendaAction.mockResolvedValue(ok(agenda(TODAY, TODAY)));
    renderAgenda();

    expect(
      await screen.findByText("Ta journée est encore libre."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /\/b\/studio-mila/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Ajouter un rendez-vous/ }),
    ).toBeTruthy();
  });
});

describe("rendering", () => {
  it("renders appointments with time, client, service and status as text", async () => {
    const user = userEvent.setup();
    actions.getAgendaAction.mockResolvedValue(
      ok(
        agenda(TODAY, TODAY, {
          appointments: [
            appointment({ local: `${TODAY}T10:00`, priceCents: 6550 }),
          ],
        }),
      ),
    );
    renderAgenda();

    const card = await screen.findByRole("button", {
      name: "10:00, Camille Roux, Rehaussement de cils, Confirmé",
    });
    await user.click(card);
    const details = within(panel());
    expect(details.getByText(/65,50/)).toBeTruthy(); // snapshot price, formatted from cents
    expect(details.getByText("Confirmé")).toBeTruthy();
  });

  it("renders blocks distinctly, including all-day closures", async () => {
    actions.getAgendaAction.mockResolvedValue(
      ok(
        agenda(TODAY, TODAY, {
          blocks: [
            block({ from: `${TODAY}T12:30`, to: `${TODAY}T15:00` }),
            block({
              kind: "closed",
              reason: "Congés",
              from: `${TODAY}T00:00`,
              to: "2026-09-30T00:00",
            }),
          ],
        }),
      ),
    );
    renderAgenda();

    expect(
      await screen.findByRole("button", {
        name: "Bloqué · Formation, 12:30 – 15:00",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Fermé · Congés.*journée entière/ }),
    ).toBeTruthy();
  });

  it("shows the network error with a retry", async () => {
    const user = userEvent.setup();
    actions.getAgendaAction.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    actions.getAgendaAction.mockResolvedValueOnce(ok(agenda(TODAY, TODAY)));
    renderAgenda();

    expect(await screen.findByText("Connexion interrompue")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(
      await screen.findByText("Ta journée est encore libre."),
    ).toBeTruthy();
    expect(actions.getAgendaAction).toHaveBeenCalledTimes(2);
  });

  it("explains an expired session", async () => {
    actions.getAgendaAction.mockResolvedValue(fail("unauthenticated"));
    renderAgenda();

    expect(await screen.findByText("Session expirée")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Me reconnecter" }).getAttribute("href"),
    ).toBe("/login");
    expect(screen.queryByText("backend text never shown")).toBeNull();
  });
});

describe("creating an appointment", () => {
  async function fillCreation(
    user: ReturnType<typeof userEvent.setup>,
    time = "16:30",
  ) {
    await user.click(buttons(/Nouveau rendez-vous/)[0]!);
    const form = within(panel());
    await waitFor(() =>
      expect(
        (form.getByLabelText("Prestation") as HTMLSelectElement).disabled,
      ).toBe(false),
    );
    await user.selectOptions(form.getByLabelText("Prestation"), SERVICE_A);
    fireEvent.change(form.getByLabelText("Heure"), { target: { value: time } });
    actions.searchAgendaClientsAction.mockResolvedValue(
      ok([
        {
          id: CLIENT_A,
          displayName: "Camille Roux",
          email: "camille@exemple.fr",
          phone: null,
        },
      ]),
    );
    await user.type(form.getByLabelText("Rechercher une cliente"), "cam");
    await user.click(await form.findByRole("button", { name: /Camille Roux/ }));
    return form;
  }

  beforeEach(() => {
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate)),
    );
  });

  it("creates with server-side values only, then shows the server's appointment", async () => {
    const user = userEvent.setup();
    renderAgenda();
    const form = await fillCreation(user);
    // One debounced search, not one per keystroke.
    expect(actions.searchAgendaClientsAction).toHaveBeenCalledTimes(1);
    expect(actions.searchAgendaClientsAction).toHaveBeenCalledWith({
      query: "cam",
    });

    const created = appointment({ local: `${TODAY}T16:30` });
    actions.createAppointmentAction.mockResolvedValue(
      ok({ appointment: created, created: true }),
    );
    await user.type(form.getByLabelText(/Note interne/), " Première visite ");
    await user.click(
      form.getByRole("button", { name: "Créer le rendez-vous" }),
    );

    await waitFor(() =>
      expect(actions.createAppointmentAction).toHaveBeenCalledTimes(1),
    );
    const input = lastCall(actions.createAppointmentAction);
    expect(input).toEqual({
      date: TODAY,
      time: "16:30",
      serviceId: SERVICE_A,
      client: { type: "existing", clientId: CLIENT_A },
      internalNotes: "Première visite",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    // Never a duration, buffer, price or business chosen by the browser.
    expect(Object.keys(input)).not.toEqual(
      expect.arrayContaining(["durationMinutes", "priceCents", "businessId"]),
    );
    expect(await within(panel()).findByText("Camille Roux")).toBeTruthy();
    await waitFor(() =>
      expect(actions.getAgendaAction.mock.calls.length).toBeGreaterThan(1),
    ); // range reloaded
  });

  it("sends one request on double submit", async () => {
    const user = userEvent.setup();
    renderAgenda();
    const form = await fillCreation(user);
    let resolve: (value: unknown) => void = () => {};
    actions.createAppointmentAction.mockReturnValue(
      new Promise((done) => (resolve = done)),
    );

    const submit = form.getByRole("button", { name: "Créer le rendez-vous" });
    await user.click(submit);
    await user.click(submit);
    fireEvent.submit(submit.closest("form")!);

    expect(actions.createAppointmentAction).toHaveBeenCalledTimes(1);
    resolve(
      ok({
        appointment: appointment({ local: `${TODAY}T16:30` }),
        created: true,
      }),
    );
    expect(await within(panel()).findByText("Rendez-vous")).toBeTruthy();
  });

  it("keeps the requestId on a network retry of the same command", async () => {
    const user = userEvent.setup();
    renderAgenda();
    const form = await fillCreation(user);
    actions.createAppointmentAction.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    actions.createAppointmentAction.mockResolvedValueOnce(
      ok({
        appointment: appointment({ local: `${TODAY}T16:30` }),
        created: false,
      }),
    );

    await user.click(
      form.getByRole("button", { name: "Créer le rendez-vous" }),
    );
    await user.click(await form.findByRole("button", { name: "Réessayer" }));

    await waitFor(() =>
      expect(actions.createAppointmentAction).toHaveBeenCalledTimes(2),
    );
    const [first, second] = actions.createAppointmentAction.mock.calls.map(
      ([input]) => input.requestId,
    );
    expect(second).toBe(first);
  });

  it("idempotency_conflict: never claims success and restarts with a new key", async () => {
    const user = userEvent.setup();
    renderAgenda();
    const form = await fillCreation(user);
    actions.createAppointmentAction.mockResolvedValueOnce(
      fail("idempotency_conflict", { requestId: ["x"] }),
    );

    await user.click(
      form.getByRole("button", { name: "Créer le rendez-vous" }),
    );
    expect(await form.findByText("Rien n’a été créé")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Nouveau rendez-vous" }),
    ).toBeTruthy();

    actions.createAppointmentAction.mockResolvedValueOnce(
      ok({
        appointment: appointment({ local: `${TODAY}T16:30` }),
        created: true,
      }),
    );
    await user.click(form.getByRole("button", { name: "Recommencer" }));
    await user.click(
      form.getByRole("button", { name: "Créer le rendez-vous" }),
    );
    await waitFor(() =>
      expect(actions.createAppointmentAction).toHaveBeenCalledTimes(2),
    );
    const [first, second] = actions.createAppointmentAction.mock.calls.map(
      ([input]) => input.requestId,
    );
    expect(second).not.toBe(first);
  });

  it("schedule_conflict: explains and keeps everything typed", async () => {
    const user = userEvent.setup();
    renderAgenda();
    const form = await fillCreation(user, "14:30");
    actions.createAppointmentAction.mockResolvedValue(
      fail("schedule_conflict"),
    );

    await user.click(
      form.getByRole("button", { name: "Créer le rendez-vous" }),
    );

    expect(
      await form.findByText(
        "Ce créneau vient d’être pris ou est indisponible. Choisis-en un autre.",
      ),
    ).toBeTruthy();
    expect((form.getByLabelText("Heure") as HTMLInputElement).value).toBe(
      "14:30",
    );
    expect((form.getByLabelText("Prestation") as HTMLSelectElement).value).toBe(
      SERVICE_A,
    );
    expect(form.getByText("Camille Roux")).toBeTruthy();
  });

  it("DST: asks which 02:30 and sends first/second", async () => {
    const user = userEvent.setup();
    renderAgenda();
    const form = await fillCreation(user, "02:30");
    fireEvent.change(form.getByLabelText("Date"), {
      target: { value: "2026-10-25" },
    });
    fireEvent.change(form.getByLabelText("Heure"), {
      target: { value: "02:30" },
    });
    actions.createAppointmentAction.mockResolvedValueOnce(
      fail("ambiguous_local_time", { occurrence: ["x"] }),
    );

    await user.click(
      form.getByRole("button", { name: "Créer le rendez-vous" }),
    );
    const summer = await form.findByRole("radio", {
      name: "02:30 — heure d’été (UTC+2)",
    });
    const winter = form.getByRole("radio", {
      name: "02:30 — heure d’hiver (UTC+1)",
    });
    expect(summer).toBeTruthy();

    actions.createAppointmentAction.mockResolvedValueOnce(
      ok({
        appointment: appointment({
          local: "2026-10-25T02:30",
          occurrence: "second",
        }),
        created: true,
      }),
    );
    await user.click(winter);
    await user.click(
      form.getByRole("button", { name: "Créer le rendez-vous" }),
    );

    await waitFor(() =>
      expect(actions.createAppointmentAction).toHaveBeenCalledTimes(2),
    );
    expect(lastCall(actions.createAppointmentAction)).toMatchObject({
      date: "2026-10-25",
      time: "02:30",
      occurrence: "second",
    });
    expect(
      await within(panel()).findByText(/02:30 \(heure d’hiver, UTC\+1\)/),
    ).toBeTruthy();
  });

  it("nonexistent spring time: says so and asks for another time", async () => {
    const user = userEvent.setup();
    renderAgenda();
    const form = await fillCreation(user, "02:30");
    actions.createAppointmentAction.mockResolvedValue(
      fail("validation_error", {
        time: ["Cette heure n’existe pas ce jour-là (changement d’heure)."],
      }),
    );

    await user.click(
      form.getByRole("button", { name: "Créer le rendez-vous" }),
    );
    expect(
      await form.findByText(
        /Cette heure n’existe pas ce jour-là \(passage à l’heure d’été\)/,
      ),
    ).toBeTruthy();
  });
});

describe("existing appointment", () => {
  const loaded = appointment({
    local: "2026-09-28T10:00",
    version: 2,
    internalNotes: "Allergie colle",
  });

  beforeEach(() => {
    useViewport(true);
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments: [loaded] })),
    );
  });

  async function openEdit(user: ReturnType<typeof userEvent.setup>) {
    const details = await openAppointment(user, /Camille Roux/);
    await user.click(within(details).getByRole("button", { name: "Modifier" }));
    const form = within(panel());
    await waitFor(() =>
      expect(
        (form.getByLabelText("Prestation") as HTMLSelectElement).disabled,
      ).toBe(false),
    );
    return form;
  }

  it("edits without inventing a reschedule: no date/time, loaded version and occurrence", async () => {
    const user = userEvent.setup();
    renderAgenda();
    const form = await openEdit(user);
    actions.updateAppointmentAction.mockResolvedValue(
      ok({ ...loaded, version: 3, internalNotes: "Allergie colle + latex" }),
    );

    await user.type(form.getByLabelText(/Note interne/), " + latex");
    await user.click(form.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() =>
      expect(actions.updateAppointmentAction).toHaveBeenCalledTimes(1),
    );
    const input = lastCall(actions.updateAppointmentAction);
    expect(input).toEqual({
      appointmentId: loaded.id,
      expectedVersion: 2,
      serviceId: SERVICE_A,
      clientId: CLIENT_A,
      internalNotes: "Allergie colle + latex",
      occurrence: null,
    });
    expect("date" in input || "time" in input).toBe(false);
    expect(
      await within(panel()).findByText("Allergie colle + latex"),
    ).toBeTruthy();
  });

  it("keeps the loaded occurrence of an ambiguous start untouched", async () => {
    const user = userEvent.setup();
    const repeated = appointment({
      local: "2026-10-25T02:30",
      occurrence: "first",
    });
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments: [repeated] })),
    );
    render(<AgendaView timezone={TZ} today="2026-10-21" slug="studio-mila" />);
    const details = await openAppointment(
      user,
      /02:30 \(heure d’été, UTC\+2\)/,
    );
    await user.click(within(details).getByRole("button", { name: "Modifier" }));
    actions.updateAppointmentAction.mockResolvedValue(
      ok({ ...repeated, version: 2 }),
    );

    await user.click(
      within(panel()).getByRole("button", { name: "Enregistrer" }),
    );

    await waitFor(() =>
      expect(actions.updateAppointmentAction).toHaveBeenCalledTimes(1),
    );
    const input = lastCall(actions.updateAppointmentAction);
    expect(input.occurrence).toBe("first");
    expect("date" in input).toBe(false);
  });

  it("changing the service uses the server's new snapshot", async () => {
    const user = userEvent.setup();
    renderAgenda();
    const form = await openEdit(user);
    actions.updateAppointmentAction.mockResolvedValue(
      ok({
        ...loaded,
        version: 3,
        service: { id: SERVICE_B, name: "Pose cil à cil" },
        durationMinutes: 120,
        priceCents: 11000,
      }),
    );

    await user.selectOptions(form.getByLabelText("Prestation"), SERVICE_B);
    await user.click(form.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() =>
      expect(lastCall(actions.updateAppointmentAction)).toMatchObject({
        serviceId: SERVICE_B,
      }),
    );
    const details = within(panel());
    expect(await details.findByText("Pose cil à cil")).toBeTruthy();
    expect(details.getByText(/110,00/)).toBeTruthy();
    expect(details.getByText(/2 h/)).toBeTruthy();
  });

  it("stale_appointment: never overwrites, offers to reload the appointment", async () => {
    const user = userEvent.setup();
    renderAgenda();
    const form = await openEdit(user);
    actions.updateAppointmentAction.mockResolvedValue(
      fail("stale_appointment"),
    );
    actions.getAgendaAppointmentAction.mockResolvedValue(
      ok({ ...loaded, version: 5, internalNotes: "Changée ailleurs" }),
    );

    await user.click(form.getByRole("button", { name: "Enregistrer" }));
    expect(
      await form.findByText(
        "Ce rendez-vous a été modifié depuis son ouverture.",
      ),
    ).toBeTruthy();

    await user.click(
      form.getByRole("button", { name: "Actualiser le rendez-vous" }),
    );
    expect(actions.getAgendaAppointmentAction).toHaveBeenCalledWith({
      appointmentId: loaded.id,
    });
    await waitFor(() =>
      expect(
        (within(panel()).getByLabelText(/Note interne/) as HTMLTextAreaElement)
          .value,
      ).toBe("Changée ailleurs"),
    );

    actions.updateAppointmentAction.mockResolvedValue(
      ok({ ...loaded, version: 6 }),
    );
    await user.click(
      within(panel()).getByRole("button", { name: "Enregistrer" }),
    );
    await waitFor(() =>
      expect(lastCall(actions.updateAppointmentAction)).toMatchObject({
        expectedVersion: 5,
      }),
    );
  });

  it("cancels with a confirmation and a reason", async () => {
    const user = userEvent.setup();
    renderAgenda();
    const details = await openAppointment(user, /Camille Roux/);
    actions.cancelAppointmentAction.mockResolvedValue(
      ok({
        ...loaded,
        version: 3,
        status: "cancelled",
        cancellationReason: "Malade",
      }),
    );

    await user.click(
      within(details).getByRole("button", { name: "Annuler le rendez-vous" }),
    );
    const dialogs = screen.getAllByRole("dialog");
    const confirm = within(dialogs[dialogs.length - 1]!);
    expect(confirm.getByText("Annuler ce rendez-vous ?")).toBeTruthy();
    expect(actions.cancelAppointmentAction).not.toHaveBeenCalled();
    await user.type(confirm.getByLabelText(/Motif/), "Malade");
    await user.click(
      confirm.getByRole("button", { name: "Annuler le rendez-vous" }),
    );

    await waitFor(() =>
      expect(actions.cancelAppointmentAction).toHaveBeenCalledWith({
        appointmentId: loaded.id,
        expectedVersion: 2,
        reason: "Malade",
      }),
    );
    expect(await within(panel()).findByText("Annulé")).toBeTruthy();
  });

  it.each([
    ["Marquer terminé", "completed", "Terminé"],
    ["Marquer absente", "no_show", "Absente"],
  ] as const)(
    "%s: confirmed, then shows the server's status",
    async (label, status, text) => {
      const user = userEvent.setup();
      renderAgenda();
      const details = await openAppointment(user, /Camille Roux/);
      actions.setAppointmentStatusAction.mockResolvedValue(
        ok({ ...loaded, version: 3, status }),
      );

      await user.click(within(details).getByRole("button", { name: label }));
      const dialogs = screen.getAllByRole("dialog");
      await user.click(
        within(dialogs[dialogs.length - 1]!).getByRole("button", {
          name: label,
        }),
      );

      await waitFor(() =>
        expect(actions.setAppointmentStatusAction).toHaveBeenCalledWith({
          appointmentId: loaded.id,
          expectedVersion: 2,
          status,
        }),
      );
      expect(await within(panel()).findByText(text)).toBeTruthy();
    },
  );

  it("invalid_status_transition is explained simply", async () => {
    const user = userEvent.setup();
    renderAgenda();
    const details = await openAppointment(user, /Camille Roux/);
    actions.setAppointmentStatusAction.mockResolvedValue(
      fail("invalid_status_transition"),
    );

    await user.click(
      within(details).getByRole("button", { name: "Marquer terminé" }),
    );
    const dialogs = screen.getAllByRole("dialog");
    await user.click(
      within(dialogs[dialogs.length - 1]!).getByRole("button", {
        name: "Marquer terminé",
      }),
    );

    expect(
      await within(panel()).findByText(
        "Ce rendez-vous ne peut plus passer dans cet état.",
      ),
    ).toBeTruthy();
  });
});

describe("blocks", () => {
  const formation = block({
    from: "2026-09-30T12:30",
    to: "2026-09-30T15:00",
    version: 4,
  });

  beforeEach(() => {
    useViewport(true);
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(
        agenda(startDate, endDate, {
          blocks:
            startDate <= "2026-09-30" && endDate >= "2026-09-30"
              ? [formation]
              : [],
        }),
      ),
    );
  });

  it("creates a block", async () => {
    const user = userEvent.setup();
    renderAgenda();
    await screen.findByRole("button", { name: /Bloqué · Formation/ });
    actions.createBlockAction.mockResolvedValue(ok(block()));

    await user.click(buttons(/Bloquer un créneau/)[0]!);
    const form = within(panel());
    fireEvent.change(form.getByLabelText("Début — heure"), {
      target: { value: "08:00" },
    });
    fireEvent.change(form.getByLabelText("Fin — heure"), {
      target: { value: "09:30" },
    });
    await user.type(form.getByLabelText(/Motif/), "Dentiste");
    await user.click(form.getByRole("button", { name: "Bloquer ce créneau" }));

    await waitFor(() =>
      expect(actions.createBlockAction).toHaveBeenCalledWith({
        allDay: false,
        startsAt: `${TODAY}T08:00`,
        endsAt: `${TODAY}T09:30`,
        reason: "Dentiste",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("creates an all-day block with inclusive days", async () => {
    const user = userEvent.setup();
    renderAgenda();
    await screen.findByRole("button", { name: /Bloqué · Formation/ });
    actions.createBlockAction.mockResolvedValue(ok(block()));

    await user.click(buttons(/Bloquer un créneau/)[0]!);
    const form = within(panel());
    await user.click(form.getByRole("switch"));
    fireEvent.change(form.getByLabelText("Au (inclus)"), {
      target: { value: "2026-10-02" },
    });
    await user.click(form.getByRole("button", { name: "Bloquer ce créneau" }));

    await waitFor(() =>
      expect(actions.createBlockAction).toHaveBeenCalledWith({
        allDay: true,
        startDate: TODAY,
        endDate: "2026-10-02",
        reason: undefined,
      }),
    );
  });

  it("edits a block with its version, sending unchanged bounds as displayed", async () => {
    const user = userEvent.setup();
    renderAgenda();
    await user.click(
      await screen.findByRole("button", { name: /Bloqué · Formation/ }),
    );
    actions.updateBlockAction.mockResolvedValue(
      ok({ ...formation, version: 5, reason: "Formation cils" }),
    );
    const form = within(panel());

    await user.clear(form.getByLabelText(/Motif/));
    await user.type(form.getByLabelText(/Motif/), "Formation cils");
    await user.click(form.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() =>
      expect(actions.updateBlockAction).toHaveBeenCalledWith({
        blockId: formation.id,
        expectedVersion: 4,
        block: {
          allDay: false,
          startsAt: "2026-09-30T12:30",
          endsAt: "2026-09-30T15:00",
          reason: "Formation cils",
        },
      }),
    );
  });

  async function staleBlockForm(user: ReturnType<typeof userEvent.setup>) {
    renderAgenda();
    await user.click(
      await screen.findByRole("button", { name: /Bloqué · Formation/ }),
    );
    actions.updateBlockAction.mockResolvedValue(fail("stale_block"));
    const form = within(panel());
    await user.click(form.getByRole("button", { name: "Enregistrer" }));
    expect(
      await form.findByText(
        "Cette période a été modifiée depuis son ouverture.",
      ),
    ).toBeTruthy();
    return form;
  }

  it("stale_block: reloads the visible range and finds the block even on another day", async () => {
    const user = userEvent.setup();
    const form = await staleBlockForm(user);
    // Moved elsewhere to Friday by another device, reason changed too.
    const moved = {
      ...block({
        from: "2026-10-02T16:00",
        to: "2026-10-02T17:00",
        reason: "Déplacé",
      }),
      id: formation.id,
      version: 7,
    };
    actions.getAgendaAction.mockResolvedValueOnce(
      ok(agenda("2026-09-28", "2026-10-04", { blocks: [moved] })),
    );

    await user.click(
      form.getByRole("button", { name: "Actualiser la période" }),
    );

    expect(actions.getAgendaAction).toHaveBeenLastCalledWith({
      startDate: "2026-09-28",
      endDate: "2026-10-04",
      includeCancelled: false,
    });
    await waitFor(() =>
      expect(
        (within(panel()).getByLabelText(/Motif/) as HTMLInputElement).value,
      ).toBe("Déplacé"),
    );
    expect(
      (within(panel()).getByLabelText("Début — date") as HTMLInputElement)
        .value,
    ).toBe("2026-10-02");
    expect(
      screen.getByRole("button", { name: /Bloqué · Déplacé, 16:00 – 17:00/ }),
    ).toBeTruthy();
  });

  it("stale_block: a block gone from the visible range is not announced as deleted", async () => {
    const user = userEvent.setup();
    const form = await staleBlockForm(user);
    actions.getAgendaAction.mockResolvedValueOnce(
      ok(agenda("2026-09-28", "2026-10-04")),
    );

    await user.click(
      form.getByRole("button", { name: "Actualiser la période" }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const notice = await screen.findByText(
      /n’apparaît plus dans la période affichée/,
    );
    expect(notice.textContent).toMatch(/déplacé ou supprimé/);
    expect(screen.queryByText(/n’existe plus/)).toBeNull();
  });

  it("block overlapping an appointment: schedule_conflict worded for blocks", async () => {
    const user = userEvent.setup();
    renderAgenda();
    await user.click(
      await screen.findByRole("button", { name: /Bloqué · Formation/ }),
    );
    actions.updateBlockAction.mockResolvedValue(fail("schedule_conflict"));

    await user.click(
      within(panel()).getByRole("button", { name: "Enregistrer" }),
    );
    expect(
      await within(panel()).findByText(/chevauche un rendez-vous/),
    ).toBeTruthy();
  });

  it("deletes a block after confirmation, with its version", async () => {
    const user = userEvent.setup();
    renderAgenda();
    await user.click(
      await screen.findByRole("button", { name: /Bloqué · Formation/ }),
    );
    actions.deleteBlockAction.mockResolvedValue(ok(undefined));

    await user.click(
      within(panel()).getByRole("button", { name: "Supprimer" }),
    );
    expect(actions.deleteBlockAction).not.toHaveBeenCalled();
    const dialogs = screen.getAllByRole("dialog");
    await user.click(
      within(dialogs[dialogs.length - 1]!).getByRole("button", {
        name: "Supprimer",
      }),
    );

    await waitFor(() =>
      expect(actions.deleteBlockAction).toHaveBeenCalledWith({
        blockId: formation.id,
        expectedVersion: 4,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("DST: a 02:30 → 02:30 block is valid and edits without any client-side refusal", async () => {
    const user = userEvent.setup();
    const repeated = block({
      from: "2026-10-25T02:30",
      fromOccurrence: "first",
      to: "2026-10-25T02:30",
      toOccurrence: "second",
      reason: "Heure en double",
    });
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { blocks: [repeated] })),
    );
    render(<AgendaView timezone={TZ} today="2026-10-21" slug="studio-mila" />);
    const card = await screen.findByRole("button", {
      name: "Bloqué · Heure en double, 02:30 – 02:30",
    });
    expect(card.style.height).toBe("56px"); // one real hour at 56 px per hour

    await user.click(card);
    const form = within(panel());
    expect(
      form.getByText(
        /02:30 \(heure d’été, UTC\+2\) → 02:30 \(heure d’hiver, UTC\+1\)/,
      ),
    ).toBeTruthy();
    actions.updateBlockAction.mockResolvedValue(
      ok({ ...repeated, version: 2, reason: "Changement d’heure" }),
    );
    await user.clear(form.getByLabelText(/Motif/));
    await user.type(form.getByLabelText(/Motif/), "Changement d’heure");
    await user.click(form.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() =>
      expect(actions.updateBlockAction).toHaveBeenCalledWith({
        blockId: repeated.id,
        expectedVersion: 1,
        block: {
          allDay: false,
          startsAt: "2026-10-25T02:30",
          endsAt: "2026-10-25T02:30",
          reason: "Changement d’heure",
        },
      }),
    );
  });
});

describe("defaults and retries", () => {
  beforeEach(() => {
    useViewport(true);
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate)),
    );
  });

  it("Nouveau rendez-vous opens on today when visible, otherwise inside the week on screen", async () => {
    const user = userEvent.setup();
    renderAgenda();
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenCalledTimes(1),
    );

    await user.click(buttons(/Nouveau rendez-vous/)[0]!);
    expect(
      (within(panel()).getByLabelText("Date") as HTMLInputElement).value,
    ).toBe(TODAY);
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Semaine suivante" }));
    await waitFor(() =>
      expect(lastCall(actions.getAgendaAction)).toMatchObject({
        startDate: "2026-10-05",
      }),
    );
    await screen.findByText("Ta semaine est encore libre.");

    await user.click(buttons(/Nouveau rendez-vous/)[0]!);
    expect(
      (within(panel()).getByLabelText("Date") as HTMLInputElement).value,
    ).toBe("2026-10-05");
    await user.keyboard("{Escape}");

    await user.click(buttons(/Bloquer un créneau/)[0]!);
    expect(
      (within(panel()).getByLabelText("Début — date") as HTMLInputElement)
        .value,
    ).toBe("2026-10-05");
  });

  it("skips non-working days when choosing the default day of another week", async () => {
    const user = userEvent.setup();
    actions.getAgendaAction.mockImplementation(
      async ({ startDate, endDate }) => {
        const data = agenda(startDate, endDate);
        // Monday and Tuesday closed: the first working day is Wednesday.
        data.workingHours.days
          .slice(0, 2)
          .forEach((day) => (day.openRanges = []));
        return ok(data);
      },
    );
    renderAgenda();
    await user.click(
      await screen.findByRole("button", { name: "Semaine suivante" }),
    );
    await screen.findByText("Ta semaine est encore libre.");

    await user.click(buttons(/Nouveau rendez-vous/)[0]!);
    expect(
      (within(panel()).getByLabelText("Date") as HTMLInputElement).value,
    ).toBe("2026-10-07");
  });

  it("client search: a failed term can be retried with the very same query", async () => {
    const user = userEvent.setup();
    renderAgenda();
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenCalledTimes(1),
    );
    await user.click(buttons(/Nouveau rendez-vous/)[0]!);
    const form = within(panel());

    actions.searchAgendaClientsAction.mockResolvedValueOnce(fail("internal"));
    await user.type(form.getByLabelText("Rechercher une cliente"), "camille");
    expect(await form.findByText("La recherche n’a pas abouti.")).toBeTruthy();
    expect(actions.searchAgendaClientsAction).toHaveBeenCalledTimes(1);

    actions.searchAgendaClientsAction.mockResolvedValueOnce(
      ok([
        { id: CLIENT_A, displayName: "Camille Roux", email: null, phone: null },
      ]),
    );
    await user.click(form.getByRole("button", { name: "Réessayer" }));

    expect(
      await form.findByRole("button", { name: /Camille Roux/ }),
    ).toBeTruthy();
    expect(actions.searchAgendaClientsAction).toHaveBeenCalledTimes(2);
    expect(actions.searchAgendaClientsAction).toHaveBeenLastCalledWith({
      query: "camille",
    });
  });

  it("client search: typing the same term again after a failure retries too", async () => {
    const user = userEvent.setup();
    renderAgenda();
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenCalledTimes(1),
    );
    await user.click(buttons(/Nouveau rendez-vous/)[0]!);
    const form = within(panel());
    const field = form.getByLabelText("Rechercher une cliente");

    actions.searchAgendaClientsAction.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    await user.type(field, "camille");
    expect(await form.findByText("La recherche n’a pas abouti.")).toBeTruthy();

    actions.searchAgendaClientsAction.mockResolvedValueOnce(ok([]));
    await user.type(field, "{Backspace}e");
    expect(await form.findByText(/Aucune cliente trouvée/)).toBeTruthy();
    expect(actions.searchAgendaClientsAction).toHaveBeenCalledTimes(2);
    expect(actions.searchAgendaClientsAction).toHaveBeenLastCalledWith({
      query: "camille",
    });
  });
});

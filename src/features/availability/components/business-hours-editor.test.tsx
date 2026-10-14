// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BusinessHoursEditor } from "./business-hours-editor";

// The weekly hours screen, from what the professional sees and does. The
// existing Server Actions are mocked at their module boundary with their
// real result shapes (BusinessHourDto[]).

const { actions } = vi.hoisted(() => ({
  actions: {
    listBusinessHoursAction: vi.fn(),
    replaceBusinessHoursAction: vi.fn(),
  },
}));
vi.mock("@/features/availability/actions/schedule", () => ({
  listBusinessHoursAction: (...args: unknown[]) =>
    actions.listBusinessHoursAction(...args),
  replaceBusinessHoursAction: (...args: unknown[]) =>
    actions.replaceBusinessHoursAction(...args),
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

let id = 0;
const range = (weekday: number, startsAt: string, endsAt: string) => {
  id += 1;
  return {
    id: `50000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    weekday,
    startsAt,
    endsAt,
  };
};
const sent = () =>
  actions.replaceBusinessHoursAction.mock.calls.at(-1)![0].hours as {
    weekday: number;
    startsAt: string;
    endsAt: string;
  }[];

async function renderEditor(hours: ReturnType<typeof range>[]) {
  actions.listBusinessHoursAction.mockResolvedValue(ok(hours));
  const view = render(<BusinessHoursEditor timezone="America/Vancouver" />);
  await flush();
  return view;
}

const day = (name: string) => within(screen.getByRole("group", { name }));
const saveButton = () =>
  screen.getByRole("button", { name: /^Enregistrer les horaires/ });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  Object.values(actions).forEach((mock) => mock.mockReset());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("weekly hours", () => {
  it("shows the stored week Monday first, in the business time zone, closed days as such", async () => {
    await renderEditor([
      range(2, "09:00", "12:30"),
      range(2, "14:00", "19:00"),
      range(6, "10:00", "24:00"),
    ]);
    expect(screen.getByText(/America\/Vancouver/)).toBeTruthy();
    expect(
      screen.getAllByRole("group").map((group) => group.getAttribute("id")),
    ).toEqual(["day-1", "day-2", "day-3", "day-4", "day-5", "day-6", "day-0"]);
    expect(day("Lundi").getByText("Fermé ce jour-là.")).toBeTruthy();
    const tuesday = day("Mardi");
    expect(
      (
        tuesday.getByRole("combobox", {
          name: "Début de la plage 2, Mardi",
        }) as HTMLSelectElement
      ).value,
    ).toBe("14:00");
    expect(
      (
        day("Samedi").getByRole("combobox", {
          name: "Fin de la plage 1, Samedi",
        }) as HTMLSelectElement
      ).value,
    ).toBe("24:00");
    expect(screen.getByText("Tout est enregistré.")).toBeTruthy();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("opening, editing and closing days sends the complete week; the saved week is what is shown", async () => {
    await renderEditor([
      range(2, "09:00", "18:00"),
      range(6, "10:00", "16:00"),
    ]);
    // Open Monday (a default range appears) and change its end.
    fireEvent.click(day("Lundi").getByRole("switch", { name: "Lundi ouvert" }));
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value: "17:30" } },
    );
    // Close Saturday.
    fireEvent.click(
      day("Samedi").getByRole("switch", { name: "Samedi ouvert" }),
    );
    // Split Tuesday in two ranges.
    fireEvent.change(
      day("Mardi").getByRole("combobox", { name: "Fin de la plage 1, Mardi" }),
      { target: { value: "12:00" } },
    );
    fireEvent.click(
      day("Mardi").getByRole("button", { name: "Ajouter une plage le mardi" }),
    );
    expect(screen.getByText("Modifications non enregistrées.")).toBeTruthy();

    const saved = [
      range(1, "09:00", "17:30"),
      range(2, "09:00", "12:00"),
      range(2, "13:00", "14:00"),
    ];
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(ok(saved));
    fireEvent.click(saveButton());
    await flush();
    expect(sent()).toEqual([
      { weekday: 1, startsAt: "09:00", endsAt: "17:30" },
      { weekday: 2, startsAt: "09:00", endsAt: "12:00" },
      { weekday: 2, startsAt: "13:00", endsAt: "14:00" },
    ]);
    expect(screen.getByText("Horaires enregistrés.")).toBeTruthy();
    expect(day("Samedi").getByText("Fermé ce jour-là.")).toBeTruthy();
  });

  it("closing every day sends an empty week (all closed), on purpose", async () => {
    await renderEditor([range(3, "09:00", "18:00")]);
    fireEvent.click(
      day("Mercredi").getByRole("switch", { name: "Mercredi ouvert" }),
    );
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(ok([]));
    fireEvent.click(saveButton());
    await flush();
    expect(sent()).toEqual([]);
  });

  it("refuses overlapping or inverted ranges before sending, on the right day, with focus there", async () => {
    await renderEditor([
      range(4, "09:00", "13:00"),
      range(4, "14:00", "18:00"),
    ]);
    fireEvent.change(
      day("Jeudi").getByRole("combobox", {
        name: "Début de la plage 2, Jeudi",
      }),
      { target: { value: "12:00" } },
    );
    fireEvent.click(saveButton());
    await flush();
    expect(actions.replaceBusinessHoursAction).not.toHaveBeenCalled();
    expect(day("Jeudi").getByRole("alert").textContent).toBe(
      "Deux plages de ce jour se chevauchent.",
    );
    expect(document.activeElement?.id).toBe("day-4");

    fireEvent.change(
      day("Jeudi").getByRole("combobox", {
        name: "Début de la plage 2, Jeudi",
      }),
      { target: { value: "19:00" } },
    );
    fireEvent.click(saveButton());
    await flush();
    expect(day("Jeudi").getByRole("alert").textContent).toBe(
      "Chaque plage doit finir après son début.",
    );
    expect(actions.replaceBusinessHoursAction).not.toHaveBeenCalled();
  });

  it("while saving, nothing can change; a failure keeps the exact week, unlocked, with a retry", async () => {
    await renderEditor([range(5, "09:00", "18:00")]);
    const end = () =>
      day("Vendredi").getByRole("combobox", {
        name: "Fin de la plage 1, Vendredi",
      }) as HTMLSelectElement;
    fireEvent.change(end(), { target: { value: "19:00" } });
    const pending = deferred();
    actions.replaceBusinessHoursAction.mockReturnValueOnce(pending.promise);
    fireEvent.click(saveButton());
    fireEvent.click(saveButton());
    await flush();
    expect(actions.replaceBusinessHoursAction).toHaveBeenCalledTimes(1);
    expect(end().disabled).toBe(true);
    fireEvent.change(end(), { target: { value: "20:00" } });
    expect(end().value).toBe("19:00");
    expect(screen.getAllByText("Enregistrement…").length).toBeGreaterThan(0);

    pending.resolve(fail("network"));
    await flush();
    expect(end().disabled).toBe(false);
    expect(end().value).toBe("19:00");
    expect(
      screen.getByText(/Tes horaires ont peut-être été enregistrés/),
    ).toBeTruthy();
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      ok([range(5, "09:00", "19:00")]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(sent()).toEqual([
      { weekday: 5, startsAt: "09:00", endsAt: "19:00" },
    ]);
    expect(screen.getByText("Horaires enregistrés.")).toBeTruthy();
  });

  it("the backend's refusal names the day; nothing is replaced", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value: "17:00" } },
    );
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      fail("validation_error", { "hours.0": ["x"] }),
    );
    fireEvent.click(saveButton());
    await flush();
    expect(day("Lundi").getByRole("alert").textContent).toMatch(/refusée/);
    expect(screen.getByText("Horaires refusés")).toBeTruthy();
    expect(screen.queryByText(/backend text/)).toBeNull();
  });

  it("a schedule changed elsewhere is never overwritten silently: compare, then choose", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value: "17:00" } },
    );
    // Edited on another device since this page was read.
    actions.listBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "08:00", "12:00")]),
    );
    fireEvent.click(saveButton());
    await flush();
    expect(actions.replaceBusinessHoursAction).not.toHaveBeenCalled();
    expect(screen.getByText("Horaires modifiés ailleurs")).toBeTruthy();
    expect(screen.getByText(/8 h – 12 h/)).toBeTruthy();

    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "09:00", "17:00")]),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remplacer par mes horaires" }),
    );
    await flush();
    expect(sent()).toEqual([
      { weekday: 1, startsAt: "09:00", endsAt: "17:00" },
    ]);
  });

  it("…or take the current schedule instead of the draft", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value: "17:00" } },
    );
    actions.listBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "08:00", "12:00")]),
    );
    fireEvent.click(saveButton());
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "Reprendre les horaires actuels" }),
    );
    expect(
      (
        day("Lundi").getByRole("combobox", {
          name: "Début de la plage 1, Lundi",
        }) as HTMLSelectElement
      ).value,
    ).toBe("08:00");
    expect(screen.getByText("Tout est enregistré.")).toBeTruthy();
    expect(actions.replaceBusinessHoursAction).not.toHaveBeenCalled();
  });

  it("a failed read says so and retries", async () => {
    actions.listBusinessHoursAction.mockResolvedValueOnce(fail("internal"));
    render(<BusinessHoursEditor timezone="Europe/Paris" />);
    await flush();
    expect(
      screen.getByText("Tes horaires n’ont pas pu être chargés."),
    ).toBeTruthy();
    actions.listBusinessHoursAction.mockResolvedValueOnce(ok([]));
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(screen.getByText("Aucun horaire pour l’instant")).toBeTruthy();
  });
});

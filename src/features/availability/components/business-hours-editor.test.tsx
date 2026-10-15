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

import {
  nextNavigationMock,
  router,
} from "../../../../tests/support/next-router";
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
vi.mock("next/navigation", () => nextNavigationMock);
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
/** The week the last save was based on (the backend compares it). */
const basis = () =>
  actions.replaceBusinessHoursAction.mock.calls.at(-1)![0].expected as {
    weekday: number;
    startsAt: string;
    endsAt: string;
  }[];
const plain = (
  hours: { weekday: number; startsAt: string; endsAt: string }[],
) =>
  hours.map(({ weekday, startsAt, endsAt }) => ({ weekday, startsAt, endsAt }));

// Two identities (signed-in user and business), as the page passes them.
const A = { userId: "user-a", businessId: "business-a" };
const B = { userId: "user-b", businessId: "business-b" };

const page = (scope = A) => (
  <>
    {/* Stands for the sidebar: an ordinary in-app link. */}
    <a href="/app/services">Prestations</a>
    <BusinessHoursEditor timezone="America/Vancouver" scope={scope} />
  </>
);

async function renderEditor(hours: ReturnType<typeof range>[], scope = A) {
  actions.listBusinessHoursAction.mockResolvedValue(ok(hours));
  const view = render(page(scope));
  await flush();
  return view;
}

const day = (name: string) => within(screen.getByRole("group", { name }));
const saveButton = () =>
  screen.getByRole("button", { name: /^Enregistrer les horaires/ });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  Object.values(actions).forEach((mock) => mock.mockReset());
  router.push.mockReset();
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  // jsdom has no scrollIntoView; some tests add one.
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
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
    const read = [range(2, "09:00", "18:00"), range(6, "10:00", "16:00")];
    await renderEditor(read);
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
    // Based on the week as it was read.
    expect(plain(basis())).toEqual(plain(read));
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

  it("sends the week it started from; nothing is read before saving", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    actions.listBusinessHoursAction.mockClear();
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value: "17:00" } },
    );
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "09:00", "17:00")]),
    );
    fireEvent.click(saveButton());
    await flush();
    expect(actions.listBusinessHoursAction).not.toHaveBeenCalled();
    expect(plain(basis())).toEqual([
      { weekday: 1, startsAt: "09:00", endsAt: "18:00" },
    ]);
    expect(screen.getByText("Horaires enregistrés.")).toBeTruthy();
  });

  it("J. changed elsewhere: the refusal shows the current week, the draft is kept, nothing is resent", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await renderEditor([range(1, "09:00", "18:00")]);
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value: "17:00" } },
    );
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      fail("stale_business_hours"),
    );
    actions.listBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "08:00", "12:00")]),
    );
    fireEvent.click(saveButton());
    await flush();
    expect(actions.replaceBusinessHoursAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Horaires modifiés ailleurs")).toBeTruthy();
    expect(screen.getByText(/8 h – 12 h/)).toBeTruthy();
    // Brought into view: below the fields, above the sticky bar.
    expect(scrolled).toHaveBeenCalled();
    // The draft is untouched, and saving waits for a choice.
    expect(
      (
        day("Lundi").getByRole("combobox", {
          name: "Fin de la plage 1, Lundi",
        }) as HTMLSelectElement
      ).value,
    ).toBe("17:00");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Horaires enregistrés.")).toBeNull();
  });

  it("K. replacing on purpose sends the draft against the week just shown", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value: "17:00" } },
    );
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      fail("stale_business_hours"),
    );
    actions.listBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "08:00", "12:00")]),
    );
    fireEvent.click(saveButton());
    await flush();

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
    expect(plain(basis())).toEqual([
      { weekday: 1, startsAt: "08:00", endsAt: "12:00" },
    ]);
    expect(screen.getByText("Horaires enregistrés.")).toBeTruthy();
    expect(screen.queryByText("Horaires modifiés ailleurs")).toBeNull();
  });

  it("L. changed again during the reconciliation: refused again, compared again, never overwritten", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value: "17:00" } },
    );
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      fail("stale_business_hours"),
    );
    actions.listBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "08:00", "12:00")]),
    );
    fireEvent.click(saveButton());
    await flush();

    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      fail("stale_business_hours"),
    );
    actions.listBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "10:00", "11:00")]),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remplacer par mes horaires" }),
    );
    await flush();
    expect(actions.replaceBusinessHoursAction).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/10 h – 11 h/)).toBeTruthy();
    expect(screen.queryByText(/8 h – 12 h/)).toBeNull();

    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "09:00", "17:00")]),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remplacer par mes horaires" }),
    );
    await flush();
    expect(plain(basis())).toEqual([
      { weekday: 1, startsAt: "10:00", endsAt: "11:00" },
    ]);
    expect(screen.getByText("Horaires enregistrés.")).toBeTruthy();
  });

  it("…or take the current schedule instead of the draft", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value: "17:00" } },
    );
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      fail("stale_business_hours"),
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
    expect(actions.replaceBusinessHoursAction).toHaveBeenCalledTimes(1);
  });

  it("…or keep editing: the draft stays, and the next save is checked again", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value: "17:00" } },
    );
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      fail("stale_business_hours"),
    );
    actions.listBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "08:00", "12:00")]),
    );
    fireEvent.click(saveButton());
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "Continuer à modifier" }),
    );
    expect(screen.queryByText("Horaires modifiés ailleurs")).toBeNull();
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value: "16:00" } },
    );
    expect(screen.getByText("Modifications non enregistrées.")).toBeTruthy();

    // Not an implicit overwrite: still based on the week first read.
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      fail("stale_business_hours"),
    );
    actions.listBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "08:00", "12:00")]),
    );
    fireEvent.click(saveButton());
    await flush();
    expect(sent()).toEqual([
      { weekday: 1, startsAt: "09:00", endsAt: "16:00" },
    ]);
    expect(plain(basis())).toEqual([
      { weekday: 1, startsAt: "09:00", endsAt: "18:00" },
    ]);
    expect(screen.getByText("Horaires modifiés ailleurs")).toBeTruthy();
  });

  it("refused as changed, but the current week cannot be read: said, nothing written, retry compares", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value: "17:00" } },
    );
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      fail("stale_business_hours"),
    );
    actions.listBusinessHoursAction.mockResolvedValueOnce(fail("network"));
    fireEvent.click(saveButton());
    await flush();
    expect(
      screen.getByText(/les horaires actuels n’ont pas pu être chargés/),
    ).toBeTruthy();
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      fail("stale_business_hours"),
    );
    actions.listBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "08:00", "12:00")]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(screen.getByText(/8 h – 12 h/)).toBeTruthy();
  });

  it("a failed read says so and retries", async () => {
    actions.listBusinessHoursAction.mockResolvedValueOnce(fail("internal"));
    render(<BusinessHoursEditor timezone="Europe/Paris" scope={A} />);
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

describe("leaving with unsaved hours", () => {
  const edit = () =>
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value: "17:00" } },
    );
  const sidebarLink = () => screen.getByRole("link", { name: "Prestations" });
  const mondayStart = () =>
    (
      day("Lundi").getByRole("combobox", {
        name: "Début de la plage 1, Lundi",
      }) as HTMLSelectElement
    ).value;
  const mondayEnd = () =>
    (
      day("Lundi").getByRole("combobox", {
        name: "Fin de la plage 1, Lundi",
      }) as HTMLSelectElement
    ).value;
  const leaveDialog = () =>
    within(
      screen.getByRole("dialog", { name: "Modifications non enregistrées" }),
    );

  it("an in-app link does not drop the edited week silently: the professional decides", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    edit();
    // fireEvent returns false when the navigation was prevented.
    expect(fireEvent.click(sidebarLink())).toBe(false);
    await flush();
    expect(router.push).not.toHaveBeenCalled();
    expect(
      leaveDialog().getByText(/ne sont pas encore enregistrés/),
    ).toBeTruthy();

    // Keep editing: the draft is intact.
    fireEvent.click(
      leaveDialog().getByRole("button", { name: "Continuer à modifier" }),
    );
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      (
        day("Lundi").getByRole("combobox", {
          name: "Fin de la plage 1, Lundi",
        }) as HTMLSelectElement
      ).value,
    ).toBe("17:00");
  });

  it("quitting without saving is an explicit choice, then navigates", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    edit();
    fireEvent.click(sidebarLink());
    await flush();
    fireEvent.click(
      leaveDialog().getByRole("button", { name: "Quitter sans enregistrer" }),
    );
    await flush();
    expect(actions.replaceBusinessHoursAction).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith("/app/services");
    // Nothing is offered back on return.
    cleanup();
    await renderEditor([range(1, "09:00", "18:00")]);
    expect(screen.queryByText(/Brouillon/)).toBeNull();
    expect(mondayEnd()).toBe("18:00");
  });

  it("save and continue: navigates only once the complete week is saved", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    edit();
    fireEvent.click(sidebarLink());
    await flush();
    const pending = deferred();
    actions.replaceBusinessHoursAction.mockReturnValueOnce(pending.promise);
    fireEvent.click(
      leaveDialog().getByRole("button", { name: /^Enregistrer et continuer/ }),
    );
    await flush();
    expect(sent()).toEqual([
      { weekday: 1, startsAt: "09:00", endsAt: "17:00" },
    ]);
    expect(router.push).not.toHaveBeenCalled();
    pending.resolve(ok([range(1, "09:00", "17:00")]));
    await flush();
    expect(router.push).toHaveBeenCalledWith("/app/services");
  });

  it("save and continue fails: stays, with the draft and the error", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    edit();
    fireEvent.click(sidebarLink());
    await flush();
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(fail("internal"));
    fireEvent.click(
      leaveDialog().getByRole("button", { name: /^Enregistrer et continuer/ }),
    );
    await flush();
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Enregistrement impossible")).toBeTruthy();
    expect(
      (
        day("Lundi").getByRole("combobox", {
          name: "Fin de la plage 1, Lundi",
        }) as HTMLSelectElement
      ).value,
    ).toBe("17:00");
  });

  it("nothing unsaved: links are not intercepted", async () => {
    await renderEditor([range(1, "09:00", "18:00")]);
    expect(fireEvent.click(sidebarLink())).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("left another way (back button): the unsaved week is offered back on return, if the saved one has not changed", async () => {
    const view = await renderEditor([range(1, "09:00", "18:00")]);
    edit();
    view.unmount();

    await renderEditor([range(1, "09:00", "18:00")]);
    expect(screen.getByText("Brouillon non enregistré restauré")).toBeTruthy();
    expect(
      (
        day("Lundi").getByRole("combobox", {
          name: "Fin de la plage 1, Lundi",
        }) as HTMLSelectElement
      ).value,
    ).toBe("17:00");
    expect(screen.getByText("Modifications non enregistrées.")).toBeTruthy();
  });

  it("N. over a schedule changed since: the kept week is restored, compared, never dropped", async () => {
    const view = await renderEditor([range(1, "09:00", "18:00")]);
    edit();
    view.unmount();

    // Saved elsewhere meanwhile.
    await renderEditor([range(1, "08:00", "12:00")]);
    expect(
      screen.getByText("Brouillon restauré, horaires modifiés"),
    ).toBeTruthy();
    expect(mondayEnd()).toBe("17:00");
    expect(screen.getByText("Horaires modifiés ailleurs")).toBeTruthy();
    expect(screen.getByText(/8 h – 12 h/)).toBeTruthy();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect(actions.replaceBusinessHoursAction).not.toHaveBeenCalled();

    // Not dropped by being shown: still there on the next return.
    cleanup();
    await renderEditor([range(1, "08:00", "12:00")]);
    expect(mondayEnd()).toBe("17:00");
  });

  it("O. replacing on purpose sends the kept week against the current one", async () => {
    const view = await renderEditor([range(1, "09:00", "18:00")]);
    edit();
    view.unmount();
    await renderEditor([range(1, "08:00", "12:00")]);

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
    expect(plain(basis())).toEqual([
      { weekday: 1, startsAt: "08:00", endsAt: "12:00" },
    ]);
    expect(screen.getByText("Horaires enregistrés.")).toBeTruthy();
    expect(screen.queryByText(/Brouillon/)).toBeNull();
  });

  it("O. …or taking the current week drops the kept one, on purpose", async () => {
    const view = await renderEditor([range(1, "09:00", "18:00")]);
    edit();
    view.unmount();
    await renderEditor([range(1, "08:00", "12:00")]);
    fireEvent.click(
      screen.getByRole("button", { name: "Reprendre les horaires actuels" }),
    );
    await flush();
    expect(mondayStart()).toBe("08:00");
    expect(screen.getByText("Tout est enregistré.")).toBeTruthy();
    cleanup();
    await renderEditor([range(1, "08:00", "12:00")]);
    expect(screen.queryByText(/Brouillon/)).toBeNull();
    expect(mondayStart()).toBe("08:00");
  });

  it("O. …or keep editing: still based on the week it started from, so saving is checked again", async () => {
    const view = await renderEditor([range(1, "09:00", "18:00")]);
    edit();
    view.unmount();
    await renderEditor([range(1, "08:00", "12:00")]);
    fireEvent.click(
      screen.getByRole("button", { name: "Continuer à modifier" }),
    );
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      fail("stale_business_hours"),
    );
    actions.listBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "08:00", "12:00")]),
    );
    fireEvent.click(saveButton());
    await flush();
    expect(plain(basis())).toEqual([
      { weekday: 1, startsAt: "09:00", endsAt: "18:00" },
    ]);
    expect(screen.getByText("Horaires modifiés ailleurs")).toBeTruthy();
    expect(mondayEnd()).toBe("17:00");
  });

  it("P. changed once more while reconciling: refused, compared again, the kept week survives", async () => {
    const view = await renderEditor([range(1, "09:00", "18:00")]);
    edit();
    view.unmount();
    await renderEditor([range(1, "08:00", "12:00")]);

    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      fail("stale_business_hours"),
    );
    actions.listBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "10:00", "11:00")]),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remplacer par mes horaires" }),
    );
    await flush();
    expect(screen.getByText(/10 h – 11 h/)).toBeTruthy();
    expect(mondayEnd()).toBe("17:00");

    // Left again before choosing: still kept, against the newest week.
    cleanup();
    await renderEditor([range(1, "10:00", "11:00")]);
    expect(mondayEnd()).toBe("17:00");
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "09:00", "17:00")]),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remplacer par mes horaires" }),
    );
    await flush();
    expect(plain(basis())).toEqual([
      { weekday: 1, startsAt: "10:00", endsAt: "11:00" },
    ]);
  });
});

// The page is rendered again for another identity (sign-in as someone else,
// another business) WITHOUT unmounting: same component instance, new props,
// as a Server Component refresh does. Nothing of A may reach B.
describe("another identity on the same mounted page", () => {
  const mondayEnd = () =>
    (
      day("Lundi").getByRole("combobox", {
        name: "Fin de la plage 1, Lundi",
      }) as HTMLSelectElement
    ).value;
  const editMonday = (value: string) =>
    fireEvent.change(
      day("Lundi").getByRole("combobox", { name: "Fin de la plage 1, Lundi" }),
      { target: { value } },
    );

  it("B. C. A's unsaved week is not shown, kept or sent under B, even with an identical schedule", async () => {
    const week = () => [range(1, "09:00", "18:00")];
    const view = await renderEditor(week(), A);
    editMonday("17:00");
    expect(screen.getByText("Modifications non enregistrées.")).toBeTruthy();

    actions.listBusinessHoursAction.mockResolvedValue(ok(week()));
    view.rerender(page(B));
    await flush();
    expect(mondayEnd()).toBe("18:00");
    expect(screen.getByText("Tout est enregistré.")).toBeTruthy();
    expect(screen.queryByText(/Brouillon/)).toBeNull();

    // Nothing of A is offered to B on return either.
    cleanup();
    await renderEditor(week(), B);
    expect(mondayEnd()).toBe("18:00");
    expect(screen.queryByText(/Brouillon/)).toBeNull();

    // B saves its own week only.
    editMonday("16:00");
    actions.replaceBusinessHoursAction.mockResolvedValueOnce(
      ok([range(1, "09:00", "16:00")]),
    );
    fireEvent.click(saveButton());
    await flush();
    expect(actions.replaceBusinessHoursAction).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual([
      { weekday: 1, startsAt: "09:00", endsAt: "16:00" },
    ]);

    // A's draft was neither copied nor cleared: offered back to A.
    cleanup();
    await renderEditor(week(), A);
    expect(screen.getByText("Brouillon non enregistré restauré")).toBeTruthy();
    expect(mondayEnd()).toBe("17:00");
  });

  it("D. A's read answering after the switch never lands in B's editor", async () => {
    const pendingA = deferred();
    actions.listBusinessHoursAction.mockReturnValueOnce(pendingA.promise);
    const view = render(page(A));
    await flush();

    actions.listBusinessHoursAction.mockResolvedValueOnce(
      ok([range(2, "10:00", "12:00")]),
    );
    view.rerender(page(B));
    await flush();
    pendingA.resolve(ok([range(1, "07:00", "08:00")]));
    await flush();
    expect(day("Lundi").getByText("Fermé ce jour-là.")).toBeTruthy();
    expect(
      (
        day("Mardi").getByRole("combobox", {
          name: "Début de la plage 1, Mardi",
        }) as HTMLSelectElement
      ).value,
    ).toBe("10:00");
  });

  it("E. A's save answering after the switch: no success, navigation or change under B", async () => {
    const view = await renderEditor([range(1, "09:00", "18:00")], A);
    editMonday("17:00");
    // Save and continue (navigates once saved), answer delayed.
    fireEvent.click(screen.getByRole("link", { name: "Prestations" }));
    await flush();
    const pendingSave = deferred();
    actions.replaceBusinessHoursAction.mockReturnValueOnce(pendingSave.promise);
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer et continuer" }),
    );
    await flush();
    expect(sent()).toEqual([
      { weekday: 1, startsAt: "09:00", endsAt: "17:00" },
    ]);

    actions.listBusinessHoursAction.mockResolvedValue(
      ok([range(3, "09:00", "12:00")]),
    );
    view.rerender(page(B));
    await flush();
    pendingSave.resolve(ok([range(1, "09:00", "17:00")]));
    await flush();
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.queryByText("Horaires enregistrés.")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(day("Lundi").getByText("Fermé ce jour-là.")).toBeTruthy();
    expect(screen.getByText("Tout est enregistré.")).toBeTruthy();
    // B can work normally: nothing is left locked.
    expect(
      (
        day("Mercredi").getByRole("combobox", {
          name: "Fin de la plage 1, Mercredi",
        }) as HTMLSelectElement
      ).disabled,
    ).toBe(false);
  });
});

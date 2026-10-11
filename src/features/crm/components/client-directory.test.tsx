// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AS_OF,
  directoryClient,
  directoryPage,
} from "../../../../tests/support/crm-fixtures";
import { DEFAULT_QUERY, type DirectoryQuery } from "../client/directory-state";
import { ClientDirectory } from "./client-directory";

const listClientsAction = vi.fn();
vi.mock("@/features/crm/actions/crm", () => ({
  listClientsAction: (...args: unknown[]) => listClientsAction(...args),
  getClientProfileAction: vi.fn(),
  listClientTimelineAction: vi.fn(),
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

const EMMA = directoryClient();
const INES = directoryClient({
  firstName: "Inès",
  lastName: "Benali",
  email: null,
  phone: "07 55 66 77 88",
  completedCount: 4,
  lastCompletedVisitAt: {
    at: "x",
    local: "2025-09-18T10:00",
    occurrence: null,
  },
  upcomingCount: 1,
  nextAppointment: {
    id: "30000000-0000-4000-8000-000000000999",
    startsAt: { at: "x", local: "2026-10-12T10:00", occurrence: null },
  },
});
const ZOE = directoryClient({
  firstName: "Zoé",
  lastName: null,
  email: null,
  phone: null,
  completedCount: 0,
  lastCompletedVisitAt: null,
  upcomingCount: 0,
  nextAppointment: null,
});

async function renderDirectory(initial: Partial<DirectoryQuery> = {}) {
  const view = render(
    <ClientDirectory
      initial={{ ...DEFAULT_QUERY, ...initial }}
      slug="studio-mila"
    />,
  );
  await flush();
  return view;
}

const rows = () =>
  within(screen.getByRole("region", { name: "Liste des clientes" }))
    .getAllByRole("link")
    .map((link) => link.getAttribute("aria-label"));
const lastInput = () =>
  listClientsAction.mock.calls[listClientsAction.mock.calls.length - 1]![0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  listClientsAction.mockReset();
  window.history.replaceState(null, "", "/app/clients");
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("list", () => {
  it("one row per customer: who, visits, last visit, next appointment; nothing invented", async () => {
    listClientsAction.mockResolvedValue(
      ok(directoryPage([EMMA, INES, ZOE], { totalCount: 132 })),
    );
    await renderDirectory();

    expect(listClientsAction).toHaveBeenCalledWith({
      query: "",
      filter: "all",
      sort: "name",
      limit: 25,
    });
    expect(screen.getByText("132 clientes")).toBeTruthy();
    expect(rows()).toEqual([
      "Emma Laurent, 12 visites, dernière le 2 oct., prochain rendez-vous sam. 24 oct. à 14:30",
      "Inès Benali, 4 visites, dernière le 18 sept. 2025, prochain rendez-vous lun. 12 oct. à 10:00",
      "Zoé, pas encore venue",
    ]);
    const zoe = screen.getByRole("link", { name: "Zoé, pas encore venue" });
    expect(zoe.getAttribute("href")).toBe(`/app/clients/${ZOE.id}`);
    expect(within(zoe).getAllByText("Pas encore venue").length).toBeGreaterThan(
      0,
    );
    expect(within(zoe).getByText("Aucun contact")).toBeTruthy();
    // No fabricated figure: no zero visit, no "0 €", no fake photo.
    expect(document.body.textContent).not.toMatch(/0 visite|€|undefined|null/);
  });

  it("search waits for a pause, restarts from the first page, and the address follows", async () => {
    listClientsAction.mockResolvedValue(ok(directoryPage([EMMA])));
    await renderDirectory();
    const search = screen.getByRole("searchbox", {
      name: "Rechercher une cliente",
    });

    fireEvent.change(search, { target: { value: "06 1" } });
    fireEvent.change(search, { target: { value: "0612" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(listClientsAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(listClientsAction).toHaveBeenCalledTimes(2);
    expect(lastInput()).toEqual({
      query: "0612",
      filter: "all",
      sort: "name",
      limit: 25,
    });
    expect(window.location.search).toBe("?q=0612");
    expect(window.sessionStorage.getItem("crm:directory")).toBe(
      "/app/clients?q=0612",
    );
  });

  it("filters and sorts with the backend's own values", async () => {
    listClientsAction.mockResolvedValue(ok(directoryPage([EMMA])));
    await renderDirectory();
    fireEvent.click(screen.getByRole("radio", { name: "Rendez-vous à venir" }));
    await flush();
    expect(lastInput()).toMatchObject({ filter: "upcoming", sort: "name" });

    fireEvent.change(screen.getByRole("combobox", { name: "Trier par" }), {
      target: { value: "next_appointment" },
    });
    await flush();
    expect(lastInput()).toMatchObject({
      filter: "upcoming",
      sort: "next_appointment",
    });
    expect(lastInput().cursor).toBeUndefined();
    expect(window.location.search).toBe(
      "?filter=upcoming&sort=next_appointment",
    );
  });

  it("opens on the list described by the address", async () => {
    listClientsAction.mockResolvedValue(ok(directoryPage([EMMA])));
    await renderDirectory({
      query: "Emma",
      filter: "visited",
      sort: "most_visits",
    });
    expect(lastInput()).toMatchObject({
      query: "Emma",
      filter: "visited",
      sort: "most_visits",
    });
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(
      "Emma",
    );
  });

  it("only the latest read is shown, whatever the order answers arrive in", async () => {
    let first!: (value: unknown) => void;
    listClientsAction.mockReturnValueOnce(
      new Promise((resolve) => (first = resolve)),
    );
    listClientsAction.mockResolvedValueOnce(ok(directoryPage([INES])));
    await renderDirectory();
    fireEvent.click(screen.getByRole("radio", { name: "Déjà venues" }));
    await flush();
    expect(rows()).toHaveLength(1);

    first(ok(directoryPage([EMMA, ZOE]))); // the older read, late
    await flush();
    expect(rows()[0]).toMatch(/^Inès Benali/);
    expect(rows()).toHaveLength(1);
  });
});

describe("pagination", () => {
  it("adds the next page, without duplicates, and moves the keyboard to the first new customer", async () => {
    listClientsAction.mockResolvedValueOnce(
      ok(directoryPage([EMMA, INES], { totalCount: 3, nextCursor: "c1" })),
    );
    await renderDirectory();
    expect(screen.getByText("2 sur 3")).toBeTruthy();

    // Live data: Inès is read again on page 2 (renamed meanwhile).
    listClientsAction.mockResolvedValueOnce(
      ok(directoryPage([INES, ZOE], { totalCount: 3, nextCursor: null })),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Voir plus de clientes" }),
    );
    await flush();

    expect(lastInput()).toEqual({
      query: "",
      filter: "all",
      sort: "name",
      limit: 25,
      cursor: "c1",
    });
    expect(rows()).toHaveLength(3);
    expect(screen.getByText("3 sur 3")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Voir plus de clientes" }),
    ).toBeNull();
    expect(document.activeElement?.getAttribute("href")).toBe(
      `/app/clients/${ZOE.id}`,
    );
  });

  it("a failed next page keeps what is shown and offers to retry", async () => {
    listClientsAction.mockResolvedValueOnce(
      ok(directoryPage([EMMA], { totalCount: 2, nextCursor: "c1" })),
    );
    await renderDirectory();
    listClientsAction.mockResolvedValueOnce(fail("internal"));
    fireEvent.click(
      screen.getByRole("button", { name: "Voir plus de clientes" }),
    );
    await flush();

    expect(rows()).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toMatch(
      /Les clientes déjà affichées restent visibles/,
    );
    listClientsAction.mockResolvedValueOnce(
      ok(directoryPage([ZOE], { totalCount: 2, nextCursor: null })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a refused cursor restarts quietly from the first page", async () => {
    listClientsAction.mockResolvedValueOnce(
      ok(directoryPage([EMMA], { totalCount: 2, nextCursor: "stale" })),
    );
    await renderDirectory();
    listClientsAction.mockResolvedValueOnce(
      fail("validation_error", { cursor: ["invalid"] }),
    );
    listClientsAction.mockResolvedValueOnce(
      ok(directoryPage([EMMA, ZOE], { totalCount: 2, asOf: AS_OF })),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Voir plus de clientes" }),
    );
    await flush();
    await flush();
    expect(lastInput().cursor).toBeUndefined();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("empty, loading and errors", () => {
  it("no customer yet: says where they come from, with real links", async () => {
    listClientsAction.mockResolvedValue(ok(directoryPage([])));
    await renderDirectory();
    expect(screen.getByText("Tes clientes apparaîtront ici")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Ouvrir l’agenda" })
        .getAttribute("href"),
    ).toBe("/app");
    expect(
      screen
        .getByRole("link", { name: /ta page de réservation/ })
        .getAttribute("href"),
    ).toBe("/b/studio-mila");
    expect(
      screen.queryByRole("button", { name: /Nouvelle cliente/ }),
    ).toBeNull();
  });

  it("no match: names the search and clears it", async () => {
    listClientsAction.mockResolvedValue(ok(directoryPage([])));
    await renderDirectory({ query: "Léa" });
    expect(
      screen.getByText("Aucune cliente ne correspond à « Léa »"),
    ).toBeTruthy();
    listClientsAction.mockResolvedValue(ok(directoryPage([EMMA])));
    fireEvent.click(
      screen.getByRole("button", { name: "Effacer la recherche" }),
    );
    await flush();
    expect(lastInput().query).toBe("");
    expect(rows()).toHaveLength(1);
  });

  it("loading shows a skeleton; a failed first page offers to retry", async () => {
    let answer!: (value: unknown) => void;
    listClientsAction.mockReturnValueOnce(
      new Promise((resolve) => (answer = resolve)),
    );
    render(<ClientDirectory initial={DEFAULT_QUERY} slug="studio-mila" />);
    expect(
      screen.getAllByText("Chargement des clientes…").length,
    ).toBeGreaterThan(0);
    answer(fail("internal"));
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(
      /La liste des clientes n’a pas pu être chargée/,
    );
    listClientsAction.mockResolvedValueOnce(ok(directoryPage([EMMA])));
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(rows()).toHaveLength(1);
  });

  it("an expired session offers to sign in again", async () => {
    listClientsAction.mockResolvedValue(fail("unauthenticated"));
    await renderDirectory();
    expect(
      screen.getByRole("link", { name: "Me reconnecter" }).getAttribute("href"),
    ).toBe("/login");
  });
});

describe("a failed refresh is never shown as a successful one", () => {
  const region = () =>
    screen.queryByRole("region", { name: "Liste des clientes" });

  it("rows of the criteria on screen stay, marked out of date, when their refresh fails", async () => {
    // The audit's sequence: "Toutes" loads, "Déjà venues" fails, back to
    // "Toutes" fails as well.
    listClientsAction.mockResolvedValueOnce(ok(directoryPage([EMMA, ZOE])));
    await renderDirectory();
    expect(rows()).toHaveLength(2);

    listClientsAction.mockResolvedValueOnce(fail("network"));
    fireEvent.click(screen.getByRole("radio", { name: "Déjà venues" }));
    await flush();
    // Nothing from "Toutes" is presented as "Déjà venues".
    expect(region()).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(
      /La liste des clientes n’a pas pu être chargée/,
    );

    listClientsAction.mockResolvedValueOnce(fail("network"));
    fireEvent.click(screen.getByRole("radio", { name: "Toutes" }));
    await flush();
    expect(lastInput()).toMatchObject({ filter: "all" });
    expect(rows()).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toMatch(
      /n’a pas pu être actualisée.*peuvent ne plus être à jour/,
    );
    // A stale cursor is not offered either.
    expect(
      screen.queryByRole("button", { name: "Voir plus de clientes" }),
    ).toBeNull();
    // No automatic retry loop.
    const calls = listClientsAction.mock.calls.length;
    await flush();
    expect(listClientsAction.mock.calls.length).toBe(calls);

    // Retry reads the criteria on screen; success removes the warning.
    listClientsAction.mockResolvedValueOnce(ok(directoryPage([EMMA])));
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(lastInput()).toMatchObject({ filter: "all", query: "" });
    expect(lastInput().cursor).toBeUndefined();
    expect(rows()).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("while the rows on screen are re-read, it says so", async () => {
    listClientsAction.mockResolvedValueOnce(ok(directoryPage([EMMA])));
    await renderDirectory();
    listClientsAction.mockResolvedValueOnce(fail("internal"));
    fireEvent.click(screen.getByRole("radio", { name: "Déjà venues" }));
    await flush();

    let answer!: (value: unknown) => void;
    listClientsAction.mockReturnValueOnce(
      new Promise((resolve) => (answer = resolve)),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Toutes" }));
    await flush();
    expect(screen.getByRole("status").textContent).toBe(
      "Actualisation de la liste…",
    );
    expect(region()!.getAttribute("aria-busy")).toBe("true");

    answer(ok(directoryPage([EMMA, ZOE])));
    await flush();
    expect(screen.queryByRole("status")).toBeNull();
    expect(region()!.getAttribute("aria-busy")).toBe("false");
    expect(rows()).toHaveLength(2);
  });

  it("new criteria never show the previous criteria's rows while they load", async () => {
    listClientsAction.mockResolvedValueOnce(ok(directoryPage([EMMA, ZOE])));
    await renderDirectory();
    listClientsAction.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.change(screen.getByRole("combobox", { name: "Trier par" }), {
      target: { value: "most_visits" },
    });
    await flush();
    expect(region()).toBeNull();
    expect(
      screen.getAllByText("Chargement des clientes…").length,
    ).toBeGreaterThan(0);
  });

  it("a late answer to older criteria cannot hide the failure of the current ones", async () => {
    listClientsAction.mockResolvedValueOnce(ok(directoryPage([EMMA])));
    await renderDirectory();
    let late!: (value: unknown) => void;
    listClientsAction.mockReturnValueOnce(
      new Promise((resolve) => (late = resolve)),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Déjà venues" }));
    await flush();
    listClientsAction.mockResolvedValueOnce(fail("internal"));
    fireEvent.change(screen.getByRole("combobox", { name: "Trier par" }), {
      target: { value: "most_visits" },
    });
    await flush();
    late(ok(directoryPage([INES]))); // "Déjà venues" by name, too late
    await flush();
    expect(region()).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(
      /n’a pas pu être chargée/,
    );
    listClientsAction.mockResolvedValueOnce(ok(directoryPage([INES])));
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(lastInput()).toMatchObject({
      filter: "visited",
      sort: "most_visits",
    });
    expect(rows()).toHaveLength(1);
  });

  it("a refused cursor whose fresh first page fails keeps the rows, marked out of date", async () => {
    listClientsAction.mockResolvedValueOnce(
      ok(directoryPage([EMMA], { totalCount: 2, nextCursor: "stale" })),
    );
    await renderDirectory();
    listClientsAction.mockResolvedValueOnce(
      fail("validation_error", { cursor: ["invalid"] }),
    );
    listClientsAction.mockResolvedValueOnce(fail("network"));
    fireEvent.click(
      screen.getByRole("button", { name: "Voir plus de clientes" }),
    );
    await flush();
    await flush();
    expect(lastInput().cursor).toBeUndefined();
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toMatch(
      /n’a pas pu être actualisée/,
    );
    expect(
      screen.queryByRole("button", { name: "Voir plus de clientes" }),
    ).toBeNull();

    listClientsAction.mockResolvedValueOnce(
      ok(directoryPage([EMMA, ZOE], { totalCount: 2 })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an expired session during a refresh keeps the rows and offers to sign in", async () => {
    listClientsAction.mockResolvedValueOnce(ok(directoryPage([EMMA])));
    await renderDirectory();
    listClientsAction.mockResolvedValueOnce(fail("internal"));
    fireEvent.click(screen.getByRole("radio", { name: "Déjà venues" }));
    await flush();
    listClientsAction.mockResolvedValueOnce(fail("unauthenticated"));
    fireEvent.click(screen.getByRole("radio", { name: "Toutes" }));
    await flush();
    expect(rows()).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "Me reconnecter" }).getAttribute("href"),
    ).toBe("/login");
  });
});

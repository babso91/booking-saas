// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SeriesActions } from "./contract";
import { addWeeks, dayOf, instantsOf } from "./local-time";
import { memorySeries } from "./memory-actions";
import { SeriesPlanner } from "./series-planner";

// The series planner against an in-memory server of the PROPOSED contract
// (docs/APPOINTMENT_SERIES_PROPOSAL.md). The real guarantees (one lock,
// quote, occupation, atomic commit) are the backend's.

afterEach(cleanup);

const PARIS = "Europe/Paris";

describe("wall-clock time in the business's zone", () => {
  it("02:30 on 25 October 2026 happens twice in Paris, on 29 March never", () => {
    expect(instantsOf("2026-10-25T02:30", PARIS)).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T01:30:00.000Z",
    ]);
    expect(instantsOf("2026-03-29T02:30", PARIS)).toEqual([]);
    expect(instantsOf("2026-10-18T02:30", PARIS)).toEqual([
      "2026-10-18T00:30:00.000Z",
    ]);
  });

  it("a repetition keeps the wall-clock time across months", () => {
    expect(addWeeks("2026-10-18T02:30", 1)).toBe("2026-10-25T02:30");
    expect(addWeeks("2026-12-28T09:00", 1)).toBe("2027-01-04T09:00");
    expect(dayOf("2026-10-01T10:00")).toBe("jeudi 1er octobre");
  });
});

const open = (
  firstLocalStart: string,
  server = memorySeries(),
  actions: SeriesActions = server.actions,
) => {
  render(
    <SeriesPlanner
      clientName="Lina"
      rule={{
        clientId: "c-lina",
        serviceId: "s-gel",
        optionChoiceIds: [],
        firstLocalStart,
      }}
      actions={actions}
    />,
  );
  return server;
};
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const select = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const weekly = async (count: number) => {
  select("Fréquence", "1");
  select(/Nombre de rendez-vous, celui-ci/, String(count));
  click("Voir les dates");
  await screen.findByRole("region", { name: "Dates de la série" });
};
const rows = () =>
  within(
    within(
      screen.getByRole("region", { name: "Dates de la série" }),
    ).getAllByRole("list")[0]!,
  ).getAllByRole("listitem");
const createButton = () =>
  screen.getByRole("button", { name: /^Créer les/ }) as HTMLButtonElement;

describe("clocks changing", () => {
  it("autumn: the doubled hour waits for her choice, and the one she picks is sent", async () => {
    const server = memorySeries();
    const commit = vi.fn(server.actions.commit);
    open("2026-10-18T02:30", server, { ...server.actions, commit });
    await weekly(3);
    const second = within(rows()[1]!);
    expect(second.getByText(/existe deux fois ce jour-là/)).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText("Une date attend ton choix.")).toBeTruthy();
    fireEvent.click(second.getByLabelText(/UTC\+1 · après le changement/));
    expect(createButton().disabled).toBe(false);
    click("Créer les 3 rendez-vous");
    await screen.findByText("3 rendez-vous créés");
    expect(commit.mock.calls[0]?.[0].selected).toEqual([
      { key: "occ-1", startsAt: "2026-10-18T00:30:00.000Z" },
      { key: "occ-2", startsAt: "2026-10-25T01:30:00.000Z" },
      { key: "occ-3", startsAt: "2026-11-01T01:30:00.000Z" },
    ]);
  });

  it("spring: the missing hour needs another time or the date removed", async () => {
    const server = memorySeries({ horizon: "2027-01-31" });
    const commit = vi.fn(server.actions.commit);
    open("2026-03-15T02:30", server, { ...server.actions, commit });
    await weekly(3);
    const third = within(rows()[2]!);
    expect(third.getByText(/n’existe pas ce jour-là/)).toBeTruthy();
    fireEvent.click(third.getByLabelText("Ne pas garder cette date"));
    expect(screen.getByText(/1 retiré par toi/)).toBeTruthy();
    fireEvent.click(third.getByLabelText("À 03:30 à la place"));
    click("Créer les 3 rendez-vous");
    await screen.findByText("3 rendez-vous créés");
    expect(commit.mock.calls[0]?.[0].selected[2]).toEqual({
      key: "occ-3",
      startsAt: "2026-03-29T01:30:00.000Z",
    });
  });
});

describe("dates that cannot be kept", () => {
  it("a taken slot and a date past the horizon are shown and counted, never dropped silently", async () => {
    open(
      "2026-11-17T10:00",
      memorySeries({
        busy: ["2026-11-24T09:00:00.000Z"],
        horizon: "2026-12-05",
      }),
    );
    await weekly(4);
    expect(rows()).toHaveLength(4);
    expect(within(rows()[1]!).getByText("Créneau déjà pris")).toBeTruthy();
    expect(
      within(rows()[3]!).getByText("Trop loin dans l’agenda"),
    ).toBeTruthy();
    expect(screen.getByText("2 rendez-vous seront créés.")).toBeTruthy();
    expect(screen.getByText(/1 exclu : créneau déjà pris/)).toBeTruthy();
    expect(screen.getByText(/1 exclu : trop loin/)).toBeTruthy();
  });

  it("more than twelve dates is refused before any preview", async () => {
    open("2026-11-17T10:00");
    select("Fréquence", "1");
    click("À une date");
    select("Dernier rendez-vous au plus tard le", "2027-06-30");
    click("Voir les dates");
    await screen.findByText(/Au plus 12 rendez-vous par série/);
  });
});

describe("confirming", () => {
  it("a slot taken meanwhile: nothing created, dates shown again, the one to review flagged", async () => {
    const server = memorySeries();
    open("2026-11-17T10:00", server);
    await weekly(3);
    server.take("2026-12-01T09:00:00.000Z");
    click("Créer les 3 rendez-vous");
    await screen.findByText(/Une place a été prise entre-temps/);
    expect(server.created).toHaveLength(0);
    const third = within(rows()[2]!);
    expect(third.getByText("Créneau déjà pris")).toBeTruthy();
    expect(screen.getByText("2 rendez-vous seront créés.")).toBeTruthy();
    click("Créer les 2 rendez-vous");
    await screen.findByText("2 rendez-vous créés");
  });

  it("a changed price: nothing created, she checks again", async () => {
    const server = memorySeries();
    open("2026-11-17T10:00", server);
    await weekly(2);
    server.changeQuote(7000);
    click("Créer les 2 rendez-vous");
    await screen.findByText(/Le prix ou la durée/);
    expect(screen.getByText(/70 € chacun/)).toBeTruthy();
    expect(server.created).toHaveLength(0);
  });

  it("a lost answer is resent with the same request id: one series", async () => {
    const server = memorySeries();
    let lose = true;
    const commit = vi.fn<SeriesActions["commit"]>(async (input) => {
      const result = await server.actions.commit(input);
      if (lose) {
        lose = false;
        return { ok: false, error: { code: "network" } };
      }
      return result;
    });
    open("2026-11-17T10:00", server, { ...server.actions, commit });
    await weekly(2);
    click("Créer les 2 rendez-vous");
    await screen.findByText(/Pas de réponse/);
    click("Créer les 2 rendez-vous");
    await screen.findByText("2 rendez-vous créés");
    expect(commit.mock.calls[0]?.[0].requestId).toBe(
      commit.mock.calls[1]?.[0].requestId,
    );
    expect(server.created).toHaveLength(1);
  });

  it("changing the rule discards the preview: nothing stale can be confirmed", async () => {
    open("2026-11-17T10:00");
    await weekly(2);
    select("Fréquence", "2");
    expect(
      screen.queryByRole("region", { name: "Dates de la série" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Voir les dates" })).toBeTruthy();
  });
});

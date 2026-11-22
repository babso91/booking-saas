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

import type { DuplicateCandidates } from "@/features/crm/data/duplicates";

import { DuplicateHint } from "./duplicate-hint";
import { DuplicateReview } from "./duplicate-review";

// Point 147 from what she sees: records that look alike, side by side, and
// « not the same person », undoable. Actions mocked at their boundary.

const { actions } = vi.hoisted(() => ({
  actions: {
    listDuplicateCandidatesAction: vi.fn(),
    setDuplicateDismissedAction: vi.fn(),
  },
}));
vi.mock("@/features/crm/actions/duplicates", () => ({
  listDuplicateCandidatesAction: (...args: unknown[]) =>
    actions.listDuplicateCandidatesAction(...args),
  setDuplicateDismissedAction: (...args: unknown[]) =>
    actions.setDuplicateDismissedAction(...args),
}));

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string) => ({
  ok: false as const,
  error: { code, message: "backend text never shown" },
});
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const person = (
  id: string,
  firstName: string,
  lastName: string | null,
  extra: Partial<DuplicateCandidates["pairs"][number]["clients"][0]> = {},
) => ({
  id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
  firstName,
  lastName,
  email: null,
  phone: null,
  createdAt: "2026-09-01T10:00:00Z",
  pastVisits: 0,
  upcoming: 0,
  lastVisitAt: null,
  ...extra,
});

const ines = person("1", "Inès", "Le Gall", {
  email: "ines@client.test",
  phone: "06 12 34 56 78",
  pastVisits: 2,
  upcoming: 1,
  lastVisitAt: "2026-11-02T09:00:00Z",
});
const ines2 = person("2", "ines", "le-gall", { phone: "+33 6 12 34 56 78" });
const paul = person("3", "Paul", "Martin", { phone: "0711111111" });
const lea = person("4", "Léa", "Bernard", { phone: "0711111111" });

const candidates: DuplicateCandidates = {
  total: 2,
  pairs: [
    { reasons: ["phone", "name"], clients: [ines, ines2] },
    { reasons: ["phone"], clients: [paul, lea] },
  ],
};

beforeEach(() => {
  Object.values(actions).forEach((mock) => mock.mockReset());
});
afterEach(cleanup);

const cards = () =>
  within(
    screen.getByRole("list", { name: "Fiches qui se ressemblent" }),
  ).getAllByRole("listitem");

describe("records that look alike", () => {
  it("side by side: why, contact, visits and a link to each record", async () => {
    actions.listDuplicateCandidatesAction.mockResolvedValue(ok(candidates));
    render(<DuplicateReview timeZone="Europe/Paris" />);
    await flush();
    const [first] = cards();
    const card = within(first!);
    expect(card.getByText("Même téléphone · Même nom")).toBeTruthy();
    expect(card.getByText("ines@client.test")).toBeTruthy();
    expect(card.getByText("Pas d’e-mail")).toBeTruthy();
    expect(
      card.getByText(
        "2 visites, la dernière le 2 novembre 2026 · 1 rendez-vous à venir",
      ),
    ).toBeTruthy();
    expect(
      card
        .getAllByRole("link", { name: /Voir la fiche/ })
        .map((link) => link.getAttribute("href")),
    ).toEqual([`/app/clients/${ines.id}`, `/app/clients/${ines2.id}`]);
    expect(screen.getByText(/ne les fusionne jamais/)).toBeTruthy();
  });

  it("« not the same person »: gone, said, and undone back in its place", async () => {
    actions.listDuplicateCandidatesAction.mockResolvedValue(ok(candidates));
    actions.setDuplicateDismissedAction.mockImplementation(
      async (input: { dismissed: boolean }) =>
        ok({ dismissed: input.dismissed }),
    );
    render(<DuplicateReview timeZone="Europe/Paris" />);
    await flush();

    fireEvent.click(
      within(cards()[0]!).getByRole("button", {
        name: "Ce n’est pas la même personne",
      }),
    );
    await flush();
    expect(actions.setDuplicateDismissedAction).toHaveBeenLastCalledWith({
      clientId: ines.id,
      otherId: ines2.id,
      dismissed: true,
    });
    expect(cards()).toHaveLength(1);
    expect(
      screen.getByText(
        /Inès Le Gall et ines le-gall ne te seront plus proposées/,
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    await flush();
    expect(actions.setDuplicateDismissedAction).toHaveBeenLastCalledWith({
      clientId: ines.id,
      otherId: ines2.id,
      dismissed: false,
    });
    expect(
      cards().map(
        (item) => within(item).getAllByText(/Inès|Paul/)[0]!.textContent,
      ),
    ).toEqual(["Inès Le Gall", "Paul Martin"]);
    expect(screen.queryByRole("button", { name: "Annuler" })).toBeNull();
  });

  it("a refused choice is said on its card; nothing is removed", async () => {
    actions.listDuplicateCandidatesAction.mockResolvedValue(ok(candidates));
    actions.setDuplicateDismissedAction.mockResolvedValue(fail("network"));
    render(<DuplicateReview timeZone="Europe/Paris" />);
    await flush();
    fireEvent.click(
      within(cards()[1]!).getByRole("button", {
        name: "Ce n’est pas la même personne",
      }),
    );
    await flush();
    expect(cards()).toHaveLength(2);
    expect(within(cards()[1]!).getByRole("alert").textContent).toBe(
      "Ton choix n’a pas pu être enregistré. Réessaie.",
    );
  });

  it("nothing to check, or a failed read that can be retried", async () => {
    actions.listDuplicateCandidatesAction
      .mockResolvedValueOnce(fail("network"))
      .mockResolvedValueOnce(ok({ total: 0, pairs: [] }));
    render(<DuplicateReview timeZone="Europe/Paris" />);
    await flush();
    expect(
      screen.getByText("Les doublons possibles n’ont pas pu être lus."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(screen.getByText(/Aucun doublon possible/)).toBeTruthy();
  });
});

describe("the directory's hint", () => {
  it("a link with the count when there are some; nothing otherwise", async () => {
    actions.listDuplicateCandidatesAction.mockResolvedValueOnce(ok(candidates));
    const { unmount } = render(<DuplicateHint />);
    await flush();
    expect(
      screen
        .getByRole("link", { name: "2 doublons possibles à vérifier" })
        .getAttribute("href"),
    ).toBe("/app/clients/doublons");
    unmount();

    for (const answer of [ok({ total: 0, pairs: [] }), fail("forbidden")]) {
      actions.listDuplicateCandidatesAction.mockResolvedValueOnce(answer);
      const view = render(<DuplicateHint />);
      await flush();
      expect(view.container.innerHTML).toBe("");
      view.unmount();
    }
  });
});

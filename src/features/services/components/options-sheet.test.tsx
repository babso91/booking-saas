// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceOption } from "@/features/catalog/model";

import type { ServiceView } from "../client/service-form";
import { OptionsSheet } from "./options-sheet";

const setServiceOptionsAction = vi.hoisted(() => vi.fn());
vi.mock("@/features/catalog/actions/catalog", () => ({
  setServiceOptionsAction: (...args: unknown[]) =>
    setServiceOptionsAction(...args),
}));

const id = (n: number) => `40000000-0000-4000-8000-00000000000${n}`;
const service: ServiceView = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "Motif au henné",
  description: null,
  durationMinutes: 45,
  priceCents: 3000,
  active: true,
  displayOrder: 0,
  categoryId: null,
  version: 4,
};
const options: ServiceOption[] = [
  {
    id: id(1),
    question: "Taille du motif",
    required: true,
    choices: [
      { id: id(2), label: "Fin", priceDeltaCents: 0, durationDeltaMinutes: 0 },
      {
        id: id(3),
        label: "Large",
        priceDeltaCents: 1250,
        durationDeltaMinutes: 20,
      },
    ],
  },
];

const handlers = { onClose: vi.fn(), onSaved: vi.fn(), onReload: vi.fn() };
const open = (saved: ServiceOption[] = options) =>
  render(<OptionsSheet service={service} saved={saved} {...handlers} />);
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const saveButton = () =>
  screen.getByRole("button", {
    name: "Enregistrer les options",
  }) as HTMLButtonElement;
const answered = (data: unknown) => ({ ok: true, data });
const refused = (code: string) => ({ ok: false, error: { code, message: "" } });

beforeEach(() => {
  setServiceOptionsAction.mockReset();
  Object.values(handlers).forEach((handler) => handler.mockReset());
});
afterEach(cleanup);

describe("a service without options", () => {
  it("says what an option is; a first question is saved whole, on the service's version", async () => {
    setServiceOptionsAction.mockResolvedValue(
      answered({ ...service, version: 5, options: [] }),
    );
    open([]);
    expect(screen.getByText(/n’a pas d’option/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    click("Ajouter une question");
    type("Question posée à ta cliente", "Zone");
    type(/^Nom, réponse 1/, "Demi-jambes");
    type(/^Prix ajouté en euros, réponse 1/, "7,50");
    type(/^Minutes ajoutées, réponse 1/, "15");
    click("Enregistrer les options");

    await waitFor(() => expect(handlers.onSaved).toHaveBeenCalledTimes(1));
    expect(setServiceOptionsAction).toHaveBeenCalledWith({
      serviceId: service.id,
      expectedVersion: 4,
      options: [
        {
          id: null,
          question: "Zone",
          required: true,
          choices: [
            {
              id: null,
              label: "Demi-jambes",
              priceDeltaCents: 750,
              durationDeltaMinutes: 15,
            },
          ],
        },
      ],
      deletedOptionIds: [],
      deletedChoiceIds: [],
    });
  });
});

describe("her saved options", () => {
  it("are shown as typed; nothing to save until she changes something", () => {
    open();
    expect(
      (screen.getByLabelText("Question posée à ta cliente") as HTMLInputElement)
        .value,
    ).toBe("Taille du motif");
    expect(
      (
        screen.getByLabelText(
          /^Prix ajouté en euros, réponse 2/,
        ) as HTMLInputElement
      ).value,
    ).toBe("12,50");
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("Aucune modification.")).toBeTruthy();
  });

  it("an answer she removes is named to the server, never deleted by omission", async () => {
    setServiceOptionsAction.mockResolvedValue(
      answered({ ...service, version: 5, options: [] }),
    );
    open();
    click(/^Retirer la réponse 2/);
    click("Facultative");
    click("Enregistrer les options");
    await waitFor(() => expect(handlers.onSaved).toHaveBeenCalled());
    const sent = setServiceOptionsAction.mock.calls[0]![0];
    expect(sent.deletedChoiceIds).toEqual([id(3)]);
    expect(sent.deletedOptionIds).toEqual([]);
    expect(sent.options[0]).toMatchObject({ id: id(1), required: false });
    expect(sent.options[0].choices.map((c: { id: string }) => c.id)).toEqual([
      id(2),
    ]);
  });

  it("a whole question removed is named too", async () => {
    setServiceOptionsAction.mockResolvedValue(
      answered({ ...service, version: 5, options: [] }),
    );
    open();
    click("Supprimer la question 1");
    click("Enregistrer les options");
    await waitFor(() => expect(handlers.onSaved).toHaveBeenCalled());
    expect(setServiceOptionsAction.mock.calls[0]![0]).toMatchObject({
      options: [],
      deletedOptionIds: [id(1)],
      deletedChoiceIds: [],
    });
  });
});

describe("what stops a save", () => {
  it("an unnamed answer or a bad price: said on its row, nothing sent", () => {
    open();
    type(/^Nom, réponse 1/, "");
    type(/^Prix ajouté en euros, réponse 2/, "douze");
    click("Enregistrer les options");
    expect(screen.getByText(/Nomme cette réponse/)).toBeTruthy();
    expect(screen.getByText(/Un montant, par exemple/)).toBeTruthy();
    expect(screen.getByText(/2 champs sont à revoir/)).toBeTruthy();
    expect(setServiceOptionsAction).not.toHaveBeenCalled();
  });

  it("changed elsewhere: nothing written, she takes the current options back", async () => {
    setServiceOptionsAction.mockResolvedValue(refused("stale_service"));
    open();
    type("Question posée à ta cliente", "Taille");
    click("Enregistrer les options");
    await screen.findByText("Cette prestation a changé ailleurs");
    expect(handlers.onSaved).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(true);
    click("Reprendre les options actuelles");
    expect(handlers.onReload).toHaveBeenCalledTimes(1);
  });

  it("no answer: said, and the same save can be sent again", async () => {
    setServiceOptionsAction
      .mockResolvedValueOnce(refused("network"))
      .mockResolvedValueOnce(answered({ ...service, version: 5, options }));
    open();
    type("Question posée à ta cliente", "Taille");
    click("Enregistrer les options");
    await screen.findByText("Pas de réponse");
    click("Enregistrer les options");
    await waitFor(() => expect(handlers.onSaved).toHaveBeenCalledTimes(1));
    expect(setServiceOptionsAction.mock.calls[1]![0]).toEqual(
      setServiceOptionsAction.mock.calls[0]![0],
    );
  });
});

describe("leaving", () => {
  it("without changes: closes; with changes: asks first", () => {
    open();
    click("Fermer");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    type("Question posée à ta cliente", "Taille");
    click("Fermer");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Quitter sans enregistrer ?")).toBeTruthy();
    click("Continuer à modifier");
    expect(screen.queryByText("Quitter sans enregistrer ?")).toBeNull();
    click("Fermer");
    click("Quitter");
    expect(handlers.onClose).toHaveBeenCalledTimes(2);
  });
});
